// The Computer pane, release 1: the Browser (spec 2026-11-06-agent-computer §6; D9, D17, D18, D26, D27, D31, D32, D35,
// D39, D43, §4.2), end to end. The agents are stand-ins (harness.ts AGENT): the app spawns them as it spawns Claude Code
// and Codex, for a Chat turn and as a Code launch's terminal process, so the bridge admits them by spawn ownership; each
// starts the plugin launcher's MCP server and calls the computer_* tools when a test asks. The sites are the fixture
// pages in fixtures/computer, served on 127.0.0.1 and reached as *.test hosts (the test switch AOS_E2E_HOST_RULES):
// shop.test is unmarked, marked.test is marked before launch; search.test stands in for DuckDuckGo, the start page and its
// search (the test seam AOS_E2E_START_PAGE). The `computer` surface is on by default since its live checks (verified:
// true); these files name it in AOS_APP_WRITE, but for the one that runs with it left out.

import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
  AGENT, FX, RC_ONLY, TOUR_BOOK, USER_DATA, addRcOnly, agentRun, badge, command, computerEnv, content, expectNoErrors, installComputerAgents, openTab,
  USER_DATA_LINK, launchApp, providerState, rail, resizeHud, restoreFixture, startOutsider, useApp, type Agent, type AgentReply, type AppHandle,
} from "./harness";

// ── the fixture sites ────────────────────────────────────────────────

interface Seen { method: string; url: string; body: string }
interface Site { port: number; seen: Seen[]; close(): Promise<void> }

const escHtml = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

/** Serves fixtures/computer/<name>.html at /<name>.html for any host, plus a same-origin POST, a redirect to a data: URL,
 *  a download, a form's GET, and a start page at / with its search at /?q= (DuckDuckGo's shape: the words, and a result
 *  that shows its address as its link's text, a page at /result no other test opens); every request is recorded. */
async function startSite(): Promise<Site> {
  const dir = path.join(__dirname, "fixtures", "computer");
  const seen: Seen[] = [];
  const html = { "content-type": "text/html; charset=utf-8" };
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (d: string) => { body += d; });
    req.on("end", () => {
      const url = req.url ?? "/";
      seen.push({ method: req.method ?? "GET", url, body });
      const page = /^\/([a-z]+)\.html$/.exec(url)?.[1];
      if (page === "count") {
        // A page that prints how many times the server has served it (the seen list holds this request already).
        const n = seen.filter((x) => x.url === "/count.html").length;
        res.writeHead(200, html).end(`<!doctype html><title>Loads</title><p id="loads">Loads: ${n}</p>`);
        return;
      }
      if (page && fs.existsSync(path.join(dir, `${page}.html`))) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(fs.readFileSync(path.join(dir, `${page}.html`)));
      } else if (url === "/continue" && req.method === "POST") {
        res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      } else if (url === "/order" && req.method === "POST") {
        res.writeHead(200, html).end("<!doctype html><title>Ordered</title><p>Ordered</p>");
      } else if (url === "/to-data") {
        res.writeHead(302, { location: "data:text/html,<p>Landed on a data page</p>" }).end();
      } else if (url === "/download/tides.csv") {
        res.writeHead(200, { "content-type": "text/csv", "content-disposition": 'attachment; filename="tides.csv"' }).end("time,height\n06:00,1.2\n");
      } else if (url.startsWith("/note?")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><title>Noted</title><p>Noted</p>");
      } else if (url === "/") {
        res.writeHead(200, html).end("<!doctype html><title>Start</title><p>Start page</p>");
      } else if (url.startsWith("/?q=")) {
        const q = new URLSearchParams(url.slice(2)).get("q") ?? "";
        const result = `http://result.test:${(server.address() as { port: number }).port}/result`;
        res.writeHead(200, html).end(`<!doctype html><title>Results</title><p>Results for ${escHtml(q)}</p><a href="${result}">${result}</a>`);
      } else if (url === "/result") {
        res.writeHead(200, html).end("<!doctype html><title>Tide table</title><p>Tide table</p>");
      } else res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as { port: number }).port, seen, close: () => new Promise((resolve) => { server.close(() => resolve()); }) };
}

let site: Site;

// The short link to the app's data folder (harness.ts USER_DATA_LINK) goes once the file's apps have closed.
test.afterAll(() => { fs.rmSync(USER_DATA_LINK, { force: true }); });
const shopUrl = () => `http://shop.test:${site.port}/shop.html`;
const repoUrl = () => `http://marked.test:${site.port}/repo.html`;
const loginUrl = () => `http://marked.test:${site.port}/login.html`;
const shopHost = () => `shop.test:${site.port}`;
const markedHost = () => `marked.test:${site.port}`;
/** The start page, standing in for DuckDuckGo's (the app's AOS_E2E_START_PAGE in the files that serve it). */
const startUrl = () => `http://search.test:${site.port}/`;
const searchHost = () => `search.test:${site.port}`;

/** marked.test as the person marked it (agent-computer D39), in the app's own data. */
function markSite(origin: string): void {
  const file = path.join(USER_DATA, "computer", "sites.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ schema: 1, origins: [origin], categories: {} }, null, 2)}\n`);
}

const editJson = (file: string, fn: (j: Record<string, any>) => void) => {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  fn(j);
  fs.writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`);
};

/** The stand-in agents as both hosts' binaries, the hosts on as asked, a sign-in on record (so Sessions runs turns), and
 *  a variable only the shell's rc file exports (C1). */
function prepare(hosts: { claude: boolean; codex: boolean }): void {
  installComputerAgents();
  addRcOnly();
  editJson(path.join(FX.claude, "agenticos.json"), (j) => { j.hosts.claude.enabled = hosts.claude; j.hosts.codex.enabled = hosts.codex; });
  providerState(hosts.claude ? "claude" : "codex", hosts);
}

// ── helpers ──────────────────────────────────────────────────────────

type Host = "claude" | "codex";
type Access = "read" | "edit" | "run";
const WS = "harbor-map";
const NOT_STARTED = "Not started by UniDeX: start this session from the Code page's New menu or a Chat thread.";

/** The HUD window's own content width, as main reports it (the OS may not clamp it to the screen). */
const windowWidth = (app: ElectronApplication): Promise<number> =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith("app://hud/"))?.getContentSize()[0] ?? 0);

/** Resizes the window, then waits until the page's innerWidth is the window's real content width and has stopped changing. Returns that width. */
async function resizeAndSettle(app: ElectronApplication, win: Page, size: { width: number; height: number }): Promise<number> {
  await resizeHud(app, size);
  let last = -1;
  await expect.poll(async () => {
    const [inner, real] = await Promise.all([win.evaluate(() => window.innerWidth), windowWidth(app)]);
    const settled = inner === real && inner === last;
    last = inner;
    return settled;
  }, { message: "the page has the window's real width and has stopped changing" }).toBe(true);
  return win.evaluate(() => window.innerWidth);
}

const reader = (win: Page) => content(win).locator(".aos-ss-reader");
const pane = (win: Page, page: "chat" | "code"): Locator => content(win).locator(`.aos-cp[data-page="${page}"]`);
const cards = (p: Locator) => p.locator(".aos-cp-ask");
/** The open thread's Done lines (a turn the agent finished). */
const doneLines = (win: Page) => reader(win).locator(".aos-ss-done", { hasText: /^Done/ });

/** A ref in a snapshot: `[e12] button "Add to basket"`. */
function refOf(snapshot: string, role: string, name: string): string {
  const m = new RegExp(`\\[(e\\d+)\\] ${role} "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).exec(snapshot);
  if (!m) throw new Error(`no ${role} "${name}" in the snapshot:\n${snapshot}`);
  return m[1];
}

/** A page's address as a reply carries it: inside the untrusted wrapper, after its origin (agent-computer D21, R69). */
const wrapped = (url: string): string => `<untrusted-page origin="${new URL(url).origin}">${url}</untrusted-page>`;

/** An acting tool's reply (session-browser S16): its one line, then the page's outline as it is now, whose wrapper names the page. */
const acted = (line: string, url: string): RegExp => {
  const re = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${re(line)}\\n\\nPage now:\\n<untrusted-page origin="${re(new URL(url).origin)}" url="${re(escHtml(url))}">`);
};

/** Holds a reply to `want`: a refusal or not, and its text when given; the failure shows the whole reply. */
function expectReply(r: AgentReply, want: { isError: boolean; text?: string | RegExp }): void {
  expect({ isError: r.isError, text: r.text }, r.text).toEqual({ isError: want.isError, text: want.text === undefined ? r.text : typeof want.text === "string" ? want.text : expect.stringMatching(want.text) });
}

/** New session in Sessions: the workspace, the host, the access level, the prompt (sessions.spec.ts's steps). */
async function newSession(win: Page, o: { workspace: string; host: Host; text: string; access: Access }): Promise<void> {
  await openTab(win, "chat");
  await content(win).locator(".aos-ss-newbtn").click();
  await expect(reader(win).locator(".aos-ss-toptitle")).toHaveText("New session");
  await reader(win).locator("select.aos-ss-workspace").selectOption(o.workspace);
  const hm = reader(win).locator(".aos-ss-toolbar .aos-hm");
  if ((await hm.locator(".aos-hm-trigger").getAttribute("data-host")) !== o.host) {
    await hm.locator(".aos-hm-trigger").click();
    await hm.locator(`.aos-hm-pop .aos-hm-host[data-host="${o.host}"]`).click();
    await hm.locator(".aos-hm-pop .aos-hm-search").press("Escape");
    await expect(hm.locator(".aos-hm-pop")).toHaveCount(0);
  }
  await expect(hm.locator(".aos-hm-trigger")).toHaveAttribute("data-host", o.host);
  const am = reader(win).locator(".aos-ss-toolbar .aos-am");
  await am.locator(".aos-am-trigger").click();
  await am.locator(`.aos-am-item[data-level="${o.access}"]`).click();
  await expect(am).toHaveAttribute("data-access", o.access);
  await reader(win).locator("textarea.aos-ss-input").fill(o.text);
  await reader(win).locator(".aos-ss-send").click();
}

/** session-browser S2: a browser starts off. Turns on the browser of the session the pane has selected, through the page's own
 *  call (`window.aos.computer.power`), so a test that drives a browser finds one, as the person's switch would give it. */
async function browserOn(h: { win: Page; app: ElectronApplication }, before: string | null): Promise<void> {
  const selected = () => h.app.evaluate(() => (globalThis as unknown as { __aosMain: { computerSelected(): string | null } }).__aosMain.computerSelected());
  // The app is shared by a describe's tests: wait until the pane has followed to the NEW session (not the last test's).
  await expect.poll(async () => { const k = await selected(); return k !== null && k !== before; }, { message: "the pane selected the new session" }).toBe(true);
  const key = await selected();
  await h.win.evaluate((k) => (window as unknown as { aos: { computer: { power(s: string, on: boolean): void } } }).aos.computer.power(k as string, true), key);
  // A browser turned on by hand opens the start page: wait for that tab, so a test's baseline and its first call see it.
  await expect.poll(() => h.win.locator(".aos-cp-tab").count(), { message: "the start page tab" }).toBeGreaterThan(0);
}

/** A Chat turn's agent: a new session in harbor-map whose prompt names it. */
async function chatAgent(h: { win: Page; app: ElectronApplication }, o: { host?: Host; text: string; access?: Access; surfaceOff?: boolean }): Promise<Agent> {
  const after = Date.now();
  const before = await h.app.evaluate(() => (globalThis as unknown as { __aosMain: { computerSelected(): string | null } }).__aosMain.computerSelected());
  const host = o.host ?? "claude";
  await newSession(h.win, { workspace: WS, host, text: o.text, access: o.access ?? "edit" });
  const run = await agentRun((r) => r.mode === "chat" && r.host === host && r.prompt === o.text, after);
  if (!o.surfaceOff) await browserOn(h, before);
  return run;
}

/** A Code launch's agent: ⌥⌘1 or ⌥⌘2, which starts the host in the vault as the terminal's own process. */
async function codeAgent(h: { win: Page; app: ElectronApplication }, host: Host, o: { surfaceOff?: boolean } = {}): Promise<Agent> {
  const win = h.win;
  const after = Date.now();
  const before = await h.app.evaluate(() => (globalThis as unknown as { __aosMain: { computerSelected(): string | null } }).__aosMain.computerSelected());
  expect(await command(win, `agentic-os:new-terminal-${host}`)).toBe(true);
  await expect(rail(win, "term")).toHaveClass(/is-active/);
  const run = await agentRun((r) => r.mode === "code" && r.host === host, after);
  if (!o.surfaceOff) await browserOn(h, before);
  return run;
}

/** Starts `call` and waits for its ask's card in `p`; returns the card and the call, still held. */
async function asked(p: Locator, call: Promise<AgentReply>, title: string | RegExp): Promise<{ card: Locator; reply: Promise<AgentReply> }> {
  const card = cards(p).filter({ has: p.page().locator(".aos-cp-asktitle", { hasText: title }) });
  await expect(card).toHaveCount(1);
  await expect(card.locator(".aos-cp-asktitle")).toHaveText(title);
  return { card, reply: call };
}

/** Runs JavaScript in the active tab of the browser of the session under test (the spec's own look; the agent cannot):
 *  the session the pane has selected, or `session` (a key such as `chat:<uuid>`). Every session has its own browser
 *  (session-browser S1), so several can show one address and the address alone does not name a page; main names the tab
 *  by its id (`__aosMain.computerPageId`), and `url` only checks that it is the page the test means. */
async function inPage<T>(app: ElectronApplication, url: string, js: string, session?: string): Promise<T> {
  // A tab the person just opened (the + or a manual On) loads its page asynchronously: wait a few seconds for the address.
  for (let i = 0; i < 50; i++) {
    try { return await inPageOnce<T>(app, url, js, session); } catch (e) {
      if (!/the active tab is at|no active tab/.test(String(e))) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return inPageOnce<T>(app, url, js, session);
}
async function inPageOnce<T>(app: ElectronApplication, url: string, js: string, session?: string): Promise<T> {
  return app.evaluate(async ({ webContents }, o) => {
    const main = (globalThis as unknown as { __aosMain: { computerPageId(session?: string): number | null } }).__aosMain;
    const id = main.computerPageId(o.session);
    const wc = id === null ? undefined : webContents.fromId(id);
    if (!wc) throw new Error(`no active tab in the browser of ${o.session ?? "the selected session"} (wanted ${o.url})`);
    if (!wc.getURL().startsWith(o.url)) throw new Error(`the active tab is at ${wc.getURL()}, not ${o.url}`);
    return wc.executeJavaScript(o.js) as Promise<T>;
  }, { url, js, session });
}

type Box = { x: number; y: number; width: number; height: number };
/** How many pixels inside `box` (3 px in from its edges) are the mask's grey, of how many (mask.ts MASK_BGRA). */
async function greyIn(app: ElectronApplication, png: string, box: Box): Promise<{ grey: number; total: number }> {
  return app.evaluate(({ nativeImage }, o) => {
    const img = nativeImage.createFromBuffer(Buffer.from(o.png, "base64"));
    const { width } = img.getSize();
    const px = img.toBitmap();
    let grey = 0, total = 0;
    for (let y = Math.ceil(o.box.y + 3); y < Math.floor(o.box.y + o.box.height - 3); y++) {
      for (let x = Math.ceil(o.box.x + 3); x < Math.floor(o.box.x + o.box.width - 3); x++) {
        const i = (y * width + x) * 4;
        total++;
        if (px[i] === 0x6e && px[i + 1] === 0x6e && px[i + 2] === 0x6e) grey++;
      }
    }
    return { grey, total };
  }, { png, box });
}

const notices = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __aosMain: { computerNotices(): Array<{ title: string; body: string }> } }).__aosMain.computerNotices());

// ── both hosts, the Computer surface on ──────────────────────────────

test.describe("both hosts, the Computer surface on", () => {
  // The start page and its search are the fixture site's (the test seam AOS_E2E_START_PAGE), once it has its port: this
  // hook runs before useApp's launch.
  const env: Record<string, string | undefined> = { AOS_APP_WRITE: "computer,sessions", ...computerEnv() };
  test.beforeAll(async () => { site = await startSite(); env.AOS_E2E_START_PAGE = startUrl(); });
  test.afterAll(async () => { await site?.close(); });
  const app = useApp({
    env,
    prepare: () => { prepare({ claude: true, codex: true }); markSite(`http://marked.test:${site.port}`); },
  });

  test("a Chat turn opens a page in the pane, snapshots it and clicks; the pane shows its tab, address and driver (§6, D19, D32)", async () => {
    const h = app();
    const { win } = h;
    const a = await chatAgent(h, { text: "computer: basic flow" });
    try {
      const status = await a.call("computer_status");
      expectReply(status, { isError: false });
      expect(status.text).toMatch(/^Browser: \S/m);
      expect(status.text).toContain("Access: this session can act");
      expectReply(await a.call("computer_open", { url: shopUrl() }), { isError: false, text: acted(`Opened the page.`, shopUrl()) });
      const p = pane(win, "chat");
      await expect(p.locator(".aos-cp-place")).not.toHaveText("");
      await expect(p.locator(".aos-cp-tab.is-active")).toContainText("Harbour shop");
      await expect(p.locator(".aos-cp-url")).toHaveValue(shopUrl());
      await expect(p.locator(".aos-cp-drive")).toHaveClass(/is-agent/);
      await expect(p.locator(".aos-cp-drivetext")).toHaveText(/ is driving$/);
      await expect(p.locator(".aos-cp-acting")).toHaveText(/^Acting: /);
      const snap = await a.call("computer_snapshot");
      expect(snap.text).toMatch(new RegExp(`^<untrusted-page origin="http://shop\\.test:${site.port}"`));
      const add = refOf(snap.text, "button", "Add to basket");
      // The address bar's switch lets agents act freely on shop.test (D39): the click goes without an ask.
      const trust = p.locator(".aos-cp-trust");
      await expect(trust).toHaveText(`Asks first on ${shopHost()}`);
      await trust.click();
      await expect(trust).toHaveText(`Acts freely on ${shopHost()}`);
      expectReply(await a.call("computer_click", { ref: add }), { isError: false, text: acted(`Clicked ${add}.`, shopUrl()) });
      await expect(cards(p)).toHaveCount(0);
      expect((await a.call("computer_snapshot")).text).toContain("Basket: 1 item");
      await trust.click();
      await expect(trust).toHaveText(`Asks first on ${shopHost()}`);
      // The pane shows this computer, so main counts it on screen (D27).
      expect((await a.call("computer_status")).text).toContain("Pane: on screen");
    } finally { await a.finish(); }
    await expect(doneLines(win)).toHaveCount(1);
    expectNoErrors(h);
  });

  test("a Code session opens a page and acts freely on a marked site; its pane follows the terminal and logs the actions (§6, D32, D35)", async () => {
    const h = app();
    const { win } = h;
    const a = await codeAgent(h, "codex");
    try {
      // C1 (R65b): main started it, with what the login shell's rc file exports, as a typed launch had.
      expect(a.run.rc).toBe(RC_ONLY.value);
      // R70: its CLI's help lists --no-daemon, so the line starts with it (its MCP server stays the CLI's own child), and
      // the New menu's preview shows exactly that argv.
      expect(a.run.argv[0]).toBe("--no-daemon");
      await content(win).locator(".aos-ntm-caret").click();
      await content(win).locator('.aos-ntm-pop .aos-ntm-row[data-key="now-codex"]').hover();
      await expect(content(win).locator(".aos-ntm-pop .aos-ntm-preview")).toHaveText(`$ exec codex ${a.run.argv.join(" ")}`);
      await win.keyboard.press("Escape");
      expect((await a.call("computer_status")).text).toMatch(/^Browser: \S/m);
      expectReply(await a.call("computer_open", { url: repoUrl() }), { isError: false });
      const p = pane(win, "code");
      await expect(p.locator(".aos-cp-place")).not.toHaveText("");
      await expect(p.locator(".aos-cp-url")).toHaveValue(repoUrl());
      await expect(p.locator(".aos-cp-trust")).toHaveText(`Acts freely on ${markedHost()}`);
      const details = refOf((await a.call("computer_snapshot")).text, "button", "Show details");
      expectReply(await a.call("computer_click", { ref: details }), { isError: false, text: acted(`Clicked ${details}.`, repoUrl()) });
      await expect(cards(p)).toHaveCount(0);
      expect((await a.call("computer_snapshot")).text).toContain("Details shown");
      // D35: a terminal has no transcript, so the pane's activity log keeps the lines.
      const log = p.locator(".aos-cp-log .aos-cp-logtext");
      await expect(log.filter({ hasText: `Opened ${repoUrl()}` })).toHaveCount(1);
      await expect(log.filter({ hasText: "Clicked “Show details”" })).toHaveCount(1);
      // Another tab in front: the Code page's pane lets its view go (R51), and main counts it off screen.
      await openTab(win, "pulse");
      await expect.poll(async () => (await a.call("computer_status")).text).toContain("Pane: off screen");
      await openTab(win, "term");
      await expect.poll(async () => (await a.call("computer_status")).text).toContain("Pane: on screen");
    } finally { await a.finish(); }
    expectNoErrors(h);
  });

  test("a Codex chip restart (code-chat C12, R66): main runs `codex resume … <id>` with the picks after the id as the terminal's own process, on the same conversation", async () => {
    const h = app();
    const { win } = h;
    await openTab(win, "term");
    const sid = "019a0000-0000-4000-8000-0000000000c1";
    const after = Date.now();
    // What a model and access pick runs (TerminalPanel.restartWith): the same host and place, a resume by the chat's id,
    // the picks. Before R66 main refused anything after the id, and the restart said "Codex did not start".
    type L = { launch(r: object): Promise<{ session: { id: string; meta: { sessionId: string | null } }; ready: Promise<string | null> }> };
    const started = await win.evaluate(async (s) => {
      const p = (window as unknown as { aosHost: { plugin: { termLauncher: L } } }).aosHost.plugin;
      const l = await p.termLauncher.launch({ host: "codex", resume: { id: s }, model: "gpt-6-luna", access: "read", chosen: { model: true, access: true } });
      let why: string | null;
      try { why = await l.ready; } catch (e) { why = `rejected: ${e instanceof Error ? e.message : String(e)}`; }
      return { id: l.session.id, why, conversation: l.session.meta.sessionId };
    }, sid);
    expect(started.why, "main started the agent itself: no fallback, no refusal").toBeNull();
    expect(started.conversation).toBe(sid);
    const a = await agentRun((r) => r.mode === "code" && r.host === "codex", after);
    try {
      expect(a.run.argv[0]).toBe("resume");
      expect(a.run.argv).toContain("-C");
      expect(a.run.argv.slice(-7), JSON.stringify(a.run.argv)).toEqual([sid, "-m", "gpt-6-luna", "-s", "read-only", "-a", "on-request"]);
    } finally { await a.finish(); }
    await win.evaluate((i) => (window as unknown as { aosHost: { plugin: { terminalPool: { remove(id: string): void } } } }).aosHost.plugin.terminalPool.remove(i), started.id);
    expectNoErrors(h);
  });

  test("+ opens the start page and words typed in the address bar search it (the fixture standing in for DuckDuckGo); an agent opens a result by its address without an ask (D39)", async () => {
    const h = app();
    const { win, app: electron } = h;
    const a = await codeAgent(h, "claude");
    try {
      const p = pane(win, "code");
      await expect(p.locator(".aos-cp-place")).not.toHaveText("");
      const before = site.seen.length;
      const tabs = await p.locator(".aos-cp-tab").count();
      await p.locator(".aos-cp-tabnew").click();
      await expect(p.locator(".aos-cp-tab")).toHaveCount(tabs + 1);
      // A tab the person opens starts on the start page: the tab reads "New tab" and the address bar is empty, as on
      // about:blank, while the site switch names the page it is on.
      await expect(p.locator(".aos-cp-trust")).toHaveText(`Asks first on ${searchHost()}`);
      await expect(p.locator(".aos-cp-tab.is-active .aos-cp-tabtitle")).toHaveText("New tab");
      await expect(p.locator(".aos-cp-url")).toHaveValue("");
      await expect(p.locator(".aos-cp-url")).toHaveAttribute("placeholder", "Search DuckDuckGo or type an address");
      expect(await inPage<string>(electron, startUrl(), "document.title")).toBe("Start");
      expect(site.seen.slice(before).some((s) => s.method === "GET" && s.url === "/")).toBe(true);
      // Words typed in the address bar search the start page.
      const words = "tide times near the harbor?";
      const search = `${startUrl()}?q=${encodeURIComponent(words)}`;
      await p.locator(".aos-cp-url").fill(words);
      await p.locator(".aos-cp-url").press("Enter");
      await expect(p.locator(".aos-cp-url")).toHaveValue(search);
      await expect(p.locator(".aos-cp-tab.is-active .aos-cp-tabtitle")).toHaveText("Results");
      expect(site.seen.slice(before).map((s) => s.url)).toContain(`/?q=${encodeURIComponent(words)}`);
      await expect(p.locator(".aos-cp-log .aos-cp-logtext").filter({ hasText: `Opened ${search}` })).toHaveCount(1);
      // The agent reads the results and opens one by the address it shows: opening a page never asks, here on a site no
      // one has marked.
      const result = `http://result.test:${site.port}/result`;
      const snap = (await a.call("computer_snapshot")).text;
      expect(snap).toContain(`Results for ${words}`);
      expect(snap).toContain(`link "${result}"`);
      expectReply(await a.call("computer_open", { url: result }), { isError: false, text: acted(`Opened the page.`, result) });
      await expect(cards(p)).toHaveCount(0);
      await expect(p.locator(".aos-cp-url")).toHaveValue(result);
      // The tab goes, so the Vault's computer is as the tests before left it.
      await p.locator(".aos-cp-tab.is-active .aos-cp-tabclose").click();
      await expect(p.locator(".aos-cp-tab")).toHaveCount(tabs);
    } finally { await a.finish(); }
    expectNoErrors(h);
  });

  test("Back, Forward and Reload work for the user (session-browser S13)", async () => {
    const h = app();
    const { win } = h;
    const a = await codeAgent(h, "claude");
    try {
      const p = pane(win, "code");
      const tabs = await p.locator(".aos-cp-tab").count();
      await p.locator(".aos-cp-tabnew").click();
      await expect(p.locator(".aos-cp-tab")).toHaveCount(tabs + 1);
      // The start page has loaded before the person types an address over it.
      await expect(p.locator(".aos-cp-trust")).toHaveText(`Asks first on ${searchHost()}`);
      const back = p.locator(".aos-cp-back"), forward = p.locator(".aos-cp-forward"), reload = p.locator(".aos-cp-reload");
      const go = async (url: string, title: string): Promise<void> => { await p.locator(".aos-cp-url").fill(url); await p.locator(".aos-cp-url").press("Enter"); await expect(p.locator(".aos-cp-log .aos-cp-logtext").filter({ hasText: `Opened ${url}` })).toHaveCount(1); await expect(p.locator(".aos-cp-tab.is-active .aos-cp-tabtitle")).toHaveText(title); };
      const hits = (urlPath: string): number => site.seen.filter((x) => x.method === "GET" && x.url === urlPath).length;
      const pageA = shopUrl(), pageB = repoUrl();
      await go(pageA, "Harbour shop");
      await go(pageB, "Harbour repo");
      await expect(back).toBeEnabled();
      await expect(forward).toBeDisabled();
      await back.click();
      await expect(p.locator(".aos-cp-url")).toHaveValue(pageA);
      await expect(forward).toBeEnabled();
      await forward.click();
      await expect(p.locator(".aos-cp-url")).toHaveValue(pageB);
      await expect(forward).toBeDisabled();
      const before = hits("/repo.html");
      await reload.click();
      await expect.poll(() => hits("/repo.html")).toBeGreaterThan(before);
      await expect(p.locator(".aos-cp-url")).toHaveValue(pageB);
      await expect(p.locator(".aos-cp-log .aos-cp-logtext").filter({ hasText: /^Went back$/ })).toHaveCount(1);
      await expect(p.locator(".aos-cp-log .aos-cp-logtext").filter({ hasText: /^Reloaded$/ })).toHaveCount(1);
      await p.locator(".aos-cp-tab.is-active .aos-cp-tabclose").click();
      await expect(p.locator(".aos-cp-tab")).toHaveCount(tabs);
    } finally { await a.finish(); }
    expectNoErrors(h);
  });

  test("an unmarked site: a click asks first; Deny leaves the page as it was and Allow once clicks (D39, D6)", async () => {
    const h = app();
    const { win } = h;
    const a = await chatAgent(h, { text: "computer: unmarked click" });
    try {
      await a.call("computer_open", { url: shopUrl() });
      const add = refOf((await a.call("computer_snapshot")).text, "button", "Add to basket");
      const p = pane(win, "chat");
      const title = `Act on a site you haven't marked: Click “Add to basket” on ${shopHost()}?`;
      const first = await asked(p, a.call("computer_click", { ref: add }), title);
      await expect(first.card.locator(".aos-cp-askbtn")).toHaveText(["Allow once", `Let it act freely on ${shopHost()}`, "Deny"]);
      await expect(p.locator(".aos-cp-count")).toHaveText("1");
      await first.card.locator('[data-answer="deny"]').click();
      // I1: the agent's reply names the ask in app-written words; the page's name for the button stays on the card.
      expectReply(await first.reply, { isError: true, text: `The user denied it (Act on a site you haven't marked: Click on ${shopHost()}): go on without it unless the user asks for it.` });
      await expect(cards(p)).toHaveCount(0);
      expect((await a.call("computer_snapshot")).text).toContain("Basket: empty");
      const second = await asked(p, a.call("computer_click", { ref: add }), title);
      await second.card.locator('[data-answer="once"]').click();
      expectReply(await second.reply, { isError: false, text: acted(`Clicked ${add}.`, shopUrl()) });
      expect((await a.call("computer_snapshot")).text).toContain("Basket: 1 item");
      // The thread shows the computer's lines as they happen (D6, D35): the open, the asks and answers, the click.
      const lines = reader(win).locator(".aos-ss-computer .aos-ss-computertext");
      for (const line of [`Opened ${shopUrl()}`, `Asked the user: ${title}`, `Denied: ${title}`, `Allowed once: ${title}`, "Clicked “Add to basket”"]) {
        await expect(lines.filter({ hasText: line }).first(), line).toBeVisible();
      }
      await expect(reader(win).locator(".aos-ss-computer .aos-ss-computerlabel").first()).toHaveText("Computer");
    } finally { await a.finish(); }
    expectNoErrors(h);
  });

  test("an unmarked site: Continue, whose click would post with fetch, asks before the POST; on Deny the server sees none (D39)", async () => {
    const h = app();
    const { win } = h;
    const a = await chatAgent(h, { text: "computer: continue posts" });
    const posts = () => site.seen.filter((s) => s.method === "POST" && s.url === "/continue");
    try {
      await a.call("computer_open", { url: shopUrl() });
      const cont = refOf((await a.call("computer_snapshot")).text, "button", "Continue");
      const p = pane(win, "chat");
      const before = posts().length;
      const title = `Act on a site you haven't marked: Click “Continue” on ${shopHost()}?`;
      const first = await asked(p, a.call("computer_click", { ref: cont }), title);
      expect(posts()).toHaveLength(before);
      await first.card.locator('[data-answer="deny"]').click();
      expectReply(await first.reply, { isError: true });
      expect((await a.call("computer_snapshot")).text).toContain("Not continued");
      expect(posts()).toHaveLength(before);
      const second = await asked(p, a.call("computer_click", { ref: cont }), title);
      await second.card.locator('[data-answer="once"]').click();
      expectReply(await second.reply, { isError: false });
      await expect.poll(() => posts().length).toBe(before + 1);
      expect(posts().at(-1)?.body).toBe('{"step":"checkout"}');
    } finally { await a.finish(); }
    expectNoErrors(h);
  });

  test("an unmarked site: opening, scrolling and Tab go without asking; Tab then Space on a button asks (D39)", async () => {
    const h = app();
    const { win, app: electron } = h;
    const a = await chatAgent(h, { text: "computer: tab then space" });
    try {
      const p = pane(win, "chat");
      expectReply(await a.call("computer_open", { url: shopUrl() }), { isError: false });
      expectReply(await a.call("computer_scroll", { dy: 900 }), { isError: false, text: acted(`Scrolled by (0, 900).`, shopUrl()) });
      await expect.poll(() => inPage<number>(electron, shopUrl(), "window.scrollY")).toBeGreaterThan(0);
      expectReply(await a.call("computer_key", { key: "Tab" }), { isError: false, text: acted(`Pressed Tab.`, shopUrl()) });
      await expect(cards(p)).toHaveCount(0);
      expect(await inPage<string>(electron, shopUrl(), "document.activeElement.id")).toBe("add");
      const title = `Act on a site you haven't marked: Press Space with “Add to basket” focused on ${shopHost()}?`;
      const space = await asked(p, a.call("computer_key", { key: "Space" }), title);
      await space.card.locator('[data-answer="deny"]').click();
      expectReply(await space.reply, { isError: true });
      expect((await a.call("computer_snapshot")).text).toContain("Basket: empty");
    } finally { await a.finish(); }
    expectNoErrors(h);
  });

  test("an unmarked site: computer_type into a field asks first, apart from computer_key; Deny types nothing, Allow types (D39)", async () => {
    const h = app();
    const { win, app: electron } = h;
    const a = await chatAgent(h, { text: "computer: type asks" });
    try {
      await a.call("computer_open", { url: shopUrl() });
      const search = refOf((await a.call("computer_snapshot")).text, "textbox", "Search");
      const p = pane(win, "chat");
      const title = `Act on a site you haven't marked: Type 4 characters into “Search” on ${shopHost()}?`;
      const first = await asked(p, a.call("computer_type", { text: "rope", ref: search }), title);
      await first.card.locator('[data-answer="deny"]').click();
      expectReply(await first.reply, { isError: true });
      expect(await inPage<string>(electron, shopUrl(), 'document.getElementById("search").value')).toBe("");
      const second = await asked(p, a.call("computer_type", { text: "rope", ref: search }), title);
      await second.card.locator('[data-answer="once"]').click();
      expectReply(await second.reply, { isError: false, text: acted(`Typed 4 characters.`, shopUrl()) });
      expect(await inPage<string>(electron, shopUrl(), 'document.getElementById("search").value')).toBe("rope");
    } finally { await a.finish(); }
    expectNoErrors(h);
  });

  test("a marked site: Merge pull request, Sign in, a download behind a plain label and Return in an ordinary field each ask (D39, D43)", async () => {
    const h = app();
    const { win } = h;
    const a = await codeAgent(h, "claude");
    try {
      await a.call("computer_open", { url: repoUrl() });
      const snap = (await a.call("computer_snapshot")).text;
      const p = pane(win, "code");
      const host = markedHost();

      const merge = await asked(p, a.call("computer_click", { ref: refOf(snap, "button", "Merge pull request") }), `Merge: Click “Merge pull request” on ${host}?`);
      await expect(merge.card.locator(".aos-cp-askbtn")).toHaveText(["Allow once", `Always on ${host}`, "Deny"]);
      await merge.card.locator('[data-answer="deny"]').click();
      expectReply(await merge.reply, { isError: true });
      expect((await a.call("computer_snapshot")).text).toContain("Open");

      const signin = await asked(p, a.call("computer_click", { ref: refOf(snap, "button", "Sign in") }), `Sign in: Click “Sign in” on ${host}?`);
      await signin.card.locator('[data-answer="deny"]').click();
      expectReply(await signin.reply, { isError: true });

      // The link's label is plain, so the click goes; the browser holds the download it starts, whatever its label.
      const report = refOf(snap, "link", "Tide table (CSV)");
      expectReply(await a.call("computer_click", { ref: report }), { isError: false });
      const download = cards(p).filter({ hasText: /^Download: / });
      await expect(download).toHaveCount(1);
      await expect(download.locator(".aos-cp-asktitle")).toHaveText(new RegExp(`^Download: Download tides\\.csv from ${host.replace(".", "\\.")}\\?$`));
      await expect(download.locator(".aos-cp-askbtn")).toHaveText(["Allow once", "Deny"]);
      // Held, the download is nowhere in Downloads, though Chromium may already have every byte of it.
      const downloads = path.join(FX.home, "Downloads");
      const listed = () => (fs.existsSync(downloads) ? fs.readdirSync(downloads) : []);
      expect(listed()).toEqual([]);
      // It waits in a private folder of the app's own in the user's temp folder, named with the app's pid.
      const temp = await h.app.evaluate(({ app: a2 }) => a2.getPath("temp"));
      const heldDirs = () => fs.readdirSync(temp).filter((n) => n.startsWith(`unidex-download-${h.app.process().pid}-`));
      expect(heldDirs()).toHaveLength(1);
      await download.locator('[data-answer="deny"]').click();
      await expect(cards(p)).toHaveCount(0);
      expect(listed()).toEqual([]);
      expect(heldDirs(), "Deny deletes the held folder").toEqual([]);
      // Allowed, it lands in Downloads under its own name.
      expectReply(await a.call("computer_click", { ref: report }), { isError: false });
      await expect(download).toHaveCount(1);
      expect(listed()).toEqual([]);
      await download.locator('[data-answer="once"]').click();
      await expect.poll(listed).toEqual(["tides.csv"]);
      expect(fs.readFileSync(path.join(downloads, "tides.csv"), "utf8")).toBe("time,height\n06:00,1.2\n");
      await expect(p.locator(".aos-cp-log .aos-cp-logtext").filter({ hasText: `Downloaded tides.csv to ${path.join(downloads, "tides.csv")}` })).toHaveCount(1);

      // Return in an ordinary field can submit its form: it asks on every site, a marked one too.
      const note = refOf(snap, "textbox", "Note");
      expectReply(await a.call("computer_click", { ref: note }), { isError: false });
      const ret = await asked(p, a.call("computer_key", { key: "Enter" }), `Press Return: Press Enter with “Note” focused on ${host}?`);
      await expect(ret.card.locator(".aos-cp-askbtn")).toHaveText(["Allow once", "Deny"]);
      await ret.card.locator('[data-answer="deny"]').click();
      expectReply(await ret.reply, { isError: true });
      expect(site.seen.filter((s) => s.url.startsWith("/note"))).toEqual([]);
    } finally { await a.finish(); }
    expectNoErrors(h);
  });

  test("a marked site: Space on a button whose label hides its text (aria-label Close, Delete repository) asks, as its click would (I3a)", async () => {
    const h = app();
    const { win, app: electron } = h;
    const a = await chatAgent(h, { text: "computer: hidden delete" });
    // Its own address (a fragment), so the spec's look finds this tab and not another computer's on the same page.
    const url = `${repoUrl()}#i3a`;
    try {
      expectReply(await a.call("computer_open", { url }), { isError: false });
      await inPage(electron, url, `(() => { const b = document.createElement("button"); b.type = "button"; b.id = "close";
        b.setAttribute("aria-label", "Close"); b.textContent = "Delete repository";
        b.addEventListener("click", () => { document.getElementById("merged").textContent = "Repository deleted"; });
        document.getElementById("details").before(b); b.focus(); return document.activeElement === b; })()`);
      const p = pane(win, "chat");
      const space = await asked(p, a.call("computer_key", { key: "Space" }), `Delete: Press Space with “Close (Delete repository)” focused on ${markedHost()}?`);
      await space.card.locator('[data-answer="deny"]').click();
      expectReply(await space.reply, { isError: true, text: `The user denied it (Delete: Press Space on ${markedHost()}): go on without it unless the user asks for it.` });
      expect((await a.call("computer_snapshot")).text).not.toContain("Repository deleted");
    } finally { await a.finish(); }
    expectNoErrors(h);
  });

  test("two same-named buttons: focus moving from one to the other while the card waits makes Allow refuse as changed (R76)", async () => {
    const h = app();
    const { win, app: electron } = h;
    const a = await chatAgent(h, { text: "computer: same-named focus" });
    // Its own address (a fragment), so the spec's look finds this tab and not another computer's on the same page.
    const url = `${shopUrl()}#r76`;
    try {
      expectReply(await a.call("computer_open", { url }), { isError: false });
      await inPage(electron, url, `(() => { for (const id of ["go1", "go2"]) { const b = document.createElement("button"); b.type = "button";
        b.id = id; b.textContent = "Go"; b.addEventListener("click", () => { document.getElementById("status").textContent = "Pressed " + id; });
        document.getElementById("add").before(b); } document.getElementById("go1").focus(); return document.activeElement.id; })()`);
      const p = pane(win, "chat");
      const space = await asked(p, a.call("computer_key", { key: "Space" }), `Act on a site you haven't marked: Press Space with “Go” focused on ${shopHost()}?`);
      expect(await inPage<string>(electron, url, `(() => { document.getElementById("go2").focus(); return document.activeElement.id; })()`)).toBe("go2");
      await space.card.locator('[data-answer="once"]').click();
      expectReply(await space.reply, { isError: true, text: `The page changed while you waited: look again. Page: ${wrapped(url)}` });
      expect(await inPage<string>(electron, url, 'document.getElementById("status").textContent')).toBe("Not continued");
    } finally { await a.finish(); }
    expectNoErrors(h);
  });

  test("a scrolled page: a ref the agent saw at the top is hit-tested where it now shows, and its click asks (D39)", async () => {
    const h = app();
    const { win, app: electron } = h;
    const a = await chatAgent(h, { text: "computer: scrolled ref" });
    // Its own address (a fragment), so the spec's look finds this tab and not another computer's on the same page.
    const url = `${shopUrl()}#scrolled-ref`;
    try {
      expectReply(await a.call("computer_open", { url }), { isError: false });
      const search = refOf((await a.call("computer_snapshot")).text, "textbox", "Search");
      // The page scrolls itself until the field shows near the top: the field is still in view (no scroll into view),
      // and DOM.getNodeForLocation, which reads document coordinates, finds nothing at its viewport point.
      const scrolled = await inPage<number>(electron, url, `(() => { window.scrollTo(0, document.getElementById("search").getBoundingClientRect().top + window.scrollY - 40); return window.scrollY; })()`);
      expect(scrolled).toBeGreaterThan(100);
      const p = pane(win, "chat");
      const ask = await asked(p, a.call("computer_click", { ref: search }), `Act on a site you haven't marked: Click “Search” on ${shopHost()}?`);
      await ask.card.locator('[data-answer="deny"]').click();
      expectReply(await ask.reply, { isError: true, text: `The user denied it (Act on a site you haven't marked: Click on ${shopHost()}): go on without it unless the user asks for it.` });
    } finally { await a.finish(); }
    expectNoErrors(h);
  });

  test("a scrolled page: an x, y click is judged on the control under that point of the view, so Merge asks though a plain block shows a scroll's height above it (D43)", async () => {
    const h = app();
    const { win, app: electron } = h;
    const a = await chatAgent(h, { text: "computer: scrolled point" });
    const url = `${repoUrl()}#scrolled-point`;
    try {
      expectReply(await a.call("computer_open", { url }), { isError: false });
      // A plain block above the page's content and room below it; the page then scrolls so the Merge button's centre
      // shows 20 px above the block's foot in the view. At that point of the document (a scroll's height above the press,
      // where a hit test without the scroll lands) is the block, which asks nothing on a marked site.
      const at = await inPage<{ x: number; y: number; scrollY: number; under: string | undefined; above: string | undefined }>(electron, url, `(() => {
        const top = document.createElement("div"); top.id = "block"; top.style.height = "300px"; document.body.prepend(top);
        const foot = document.createElement("div"); foot.style.height = "1500px"; document.body.append(foot);
        const m = document.getElementById("merge").getBoundingClientRect(), block = top.getBoundingClientRect();
        window.scrollTo(0, m.top + m.height / 2 - (block.bottom - 20));
        const now = document.getElementById("merge").getBoundingClientRect();
        const x = Math.round(now.left + now.width / 2), y = Math.round(now.top + now.height / 2);
        return { x, y, scrollY: window.scrollY, under: document.elementFromPoint(x, y)?.id, above: document.elementFromPoint(x, y - window.scrollY)?.id };
      })()`);
      expect(at.scrollY).toBeGreaterThan(0);
      expect([at.under, at.above]).toEqual(["merge", "block"]);
      const p = pane(win, "chat");
      const merge = await asked(p, a.call("computer_click", { x: at.x, y: at.y }), `Merge: Click “Merge pull request” on ${markedHost()}?`);
      await merge.card.locator('[data-answer="deny"]').click();
      expectReply(await merge.reply, { isError: true });
      expect(await inPage<string>(electron, url, 'document.getElementById("merged").textContent')).toBe("Open");
    } finally { await a.finish(); }
    expectNoErrors(h);
  });

  test("typing stops at the chunk whose input event sends the page elsewhere; nothing reaches the next page (I3b)", async () => {
    const h = app();
    const a = await chatAgent(h, { text: "computer: typing navigates" });
    const typing = `http://marked.test:${site.port}/typing.html`;
    try {
      expectReply(await a.call("computer_open", { url: typing }), { isError: false });
      const log = refOf((await a.call("computer_snapshot")).text, "textbox", "Log entry");
      const r = await a.call("computer_type", { ref: log, text: "a".repeat(450) });
      expectReply(r, { isError: true, text: /^Typing stopped part way because the page or tab changed: call computer_snapshot to see what was typed\. Page: / });
      await expect.poll(() => site.seen.some((x) => x.url === "/landed.html")).toBe(true);
      await expect.poll(async () => (await a.call("computer_snapshot")).text, { timeout: 10_000 }).toContain("Nothing typed here");
    } finally { await a.finish(); }
    expectNoErrors(h);
  });

  test("a page's request for the microphone or the location, which the app cannot grant, is denied without a card and says so in the thread (M10)", async () => {
    const h = app();
    const { win, app: electron } = h;
    const a = await chatAgent(h, { text: "computer: ungrantable permissions" });
    // 127.0.0.1 is a secure context (a *.test page over http may not even ask) and a local address (acts freely).
    const local = `http://127.0.0.1:${site.port}/shop.html`;
    const host = `127.0.0.1:${site.port}`;
    const lines = reader(win).locator(".aos-ss-computer .aos-ss-computertext");
    try {
      expectReply(await a.call("computer_open", { url: local }), { isError: false });
      await inPage(electron, local, `(() => { navigator.mediaDevices.getUserMedia({ audio: true }).then(() => { document.title = "media: granted"; }, (e) => { document.title = "media: " + e.name; }); return true; })()`);
      await expect.poll(() => inPage<string>(electron, local, "document.title")).toBe("media: NotAllowedError");
      await expect(lines.filter({ hasText: `Denied ${host} the camera or microphone without asking: this app has no access to them on this Mac, so allowing would do nothing.` })).toHaveCount(1);
      await inPage(electron, local, `(() => { navigator.geolocation.getCurrentPosition(() => { document.title = "geo: granted"; }, (e) => { document.title = "geo: " + e.code; }); return true; })()`);
      await expect.poll(() => inPage<string>(electron, local, "document.title")).toBe("geo: 1");
      await expect(lines.filter({ hasText: `Denied ${host} your location without asking: this app has no access to it on this Mac, so allowing would do nothing.` })).toHaveCount(1);
      await expect(cards(pane(win, "chat"))).toHaveCount(0);
    } finally { await a.finish(); }
    expectNoErrors(h);
  });

  test("computer_open refuses javascript: and data: URLs, and a page that redirects to a data: URL (§4.2)", async () => {
    const h = app();
    const a = await chatAgent(h, { text: "computer: schemes" });
    try {
      expectReply(await a.call("computer_open", { url: "javascript:document.title='x'" }), { isError: true, text: "Only http and https pages open: give an address that starts with http:// or https://." });
      expectReply(await a.call("computer_open", { url: "data:text/html,<p>A data page</p>" }), { isError: true, text: "Only http and https pages open: give an address that starts with http:// or https://." });
      const errors = h.errors.length;
      const redirect = await a.call("computer_open", { url: `http://shop.test:${site.port}/to-data` });
      expectReply(redirect, { isError: true });
      expect(redirect.text).toMatch(/^The page redirected to a .+ URL, which this browser refuses: open another page, or ask the user to finish this one in their own browser\.$/);
      expect(site.seen.some((s) => s.url === "/to-data")).toBe(true);
      const snap = await a.call("computer_snapshot");
      expect(snap.text).not.toContain("Landed on a data page");
      expect(snap.text).not.toMatch(/url="data:/);
      // Electron writes a warning to stderr whenever a page's load fails: here the refused redirect's, and only that one.
      const warning = `electron: Failed to load URL: http://shop.test:${site.port}/to-data with error: ERR_UNSAFE_REDIRECT`;
      await expect.poll(() => h.errors.slice(errors).some((e) => e.includes(warning))).toBe(true);
      const late = h.errors.splice(errors);
      expect(late.filter((e) => !e.includes(warning))).toEqual([]);
    } finally { await a.finish(); }
    expectNoErrors(h);
  });

  test("a password field is redacted in the snapshot and painted over in the screenshot, also after Show password (D9)", async () => {
    const h = app();
    const { app: electron } = h;
    const a = await chatAgent(h, { text: "computer: passwords" });
    const SECRET = "ebbtide-harbour-42";
    try {
      await a.call("computer_open", { url: loginUrl() });
      const check = async (label: string): Promise<void> => {
        const snap = (await a.call("computer_snapshot")).text;
        expect(snap, label).toMatch(/\[e\d+\] textbox "Password" value="••••••"/);
        expect(snap, label).toContain('value="harbourmaster"');
        expect(snap, label).not.toContain(SECRET);
        const shot = await a.call("computer_screenshot");
        expect(shot.text, label).toBe(`A screenshot of ${wrapped(loginUrl())}, with password fields painted over.`);
        expect(shot.image, label).toBeTruthy();
        const box = await inPage<Box>(electron, loginUrl(), '(({ x, y, width, height }) => ({ x, y, width, height }))(document.getElementById("pw").getBoundingClientRect())');
        const user = await inPage<Box>(electron, loginUrl(), '(({ x, y, width, height }) => ({ x, y, width, height }))(document.getElementById("user").getBoundingClientRect())');
        const pw = await greyIn(electron, shot.image!, box);
        expect(pw.total, label).toBeGreaterThan(1000);
        expect(pw.grey, `${label}: every pixel of the password field is the mask's grey`).toBe(pw.total);
        const plain = await greyIn(electron, shot.image!, user);
        expect(plain.grey, `${label}: the username field is not painted over`).toBeLessThan(plain.total / 2);
      };
      await check("as loaded");
      const snap = (await a.call("computer_snapshot")).text;
      expectReply(await a.call("computer_type", { text: "guess", ref: refOf(snap, "textbox", "Password") }), { isError: true, text: "Typing into a password field is refused: ask the user to type it themselves." });
      // Show password is an ordinary control on the marked site: it goes, and the field shows its text to the eye.
      expectReply(await a.call("computer_click", { ref: refOf(snap, "button", "Show password") }), { isError: false });
      expect(await inPage<string>(electron, loginUrl(), 'document.getElementById("pw").type')).toBe("text");
      await check("after Show password");
    } finally { await a.finish(); }
    expectNoErrors(h);
  });

  test("a Read only session can snapshot and screenshot but not open, click or type (D17)", async () => {
    const h = app();
    const { win } = h;
    // A Read only session cannot open a page, and it has a browser of its own now: the person opens the page in it, through
    // the pane's address bar, and the agent looks at it.
    const a = await chatAgent(h, { text: "computer: read only", access: "read" });
    try {
      const p = pane(win, "chat");
      await expect(p.locator(".aos-cp-url")).toBeEnabled();
      await p.locator(".aos-cp-tabnew").click();
      await p.locator(".aos-cp-url").fill(shopUrl());
      await p.locator(".aos-cp-url").press("Enter");
      await expect(p.locator(".aos-cp-tab.is-active")).toContainText("Harbour shop");
      expect((await a.call("computer_status")).text).toContain("Access: read only: this session can look but not act (D17)");
      const snap = await a.call("computer_snapshot");
      expectReply(snap, { isError: false });
      expect((await a.call("computer_screenshot")).image).toBeTruthy();
      const refused = { isError: true, text: "This session is read only, so it can look but not act: ask the user for more access if the task needs it." };
      expectReply(await a.call("computer_click", { ref: refOf(snap.text, "button", "Add to basket") }), refused);
      expectReply(await a.call("computer_open", { url: shopUrl() }), refused);
      expectReply(await a.call("computer_type", { text: "rope" }), refused);
      await expect(cards(pane(win, "chat"))).toHaveCount(0);
    } finally { await a.finish(); }
    expectNoErrors(h);
  });

  test("two sessions in one workspace have separate browsers and neither is busy (session-browser S1)", async () => {
    const h = app();
    const first = await chatAgent(h, { host: "claude", text: "computer: first driver" });
    const second = await chatAgent(h, { host: "codex", text: "computer: second driver" });
    try {
      expectReply(await first.call("computer_open", { url: shopUrl() }), { isError: false });
      expectReply(await second.call("computer_open", { url: repoUrl() }), { isError: false });
      const tabs = (r: { text: string }) => r.text.split("\n").filter((l) => /^ {2}\[\d+\]/.test(l));
      expect(tabs(await first.call("computer_status")).join("\n")).toContain(shopHost());
      expect(tabs(await first.call("computer_status")).join("\n")).not.toContain(markedHost());
      expect(tabs(await second.call("computer_status")).join("\n")).toContain(markedHost());
      expect((await second.call("computer_status")).text).toMatch(/^Driving: this session /m);
    } finally { await first.finish(); await second.finish(); }
    expectNoErrors(h);
  });

  test("a fifth awake browser puts the least recently used to sleep, never the selected one (session-browser S9)", async () => {
    const h = app();
    const { win } = h;
    // computer.awake 2 instead of 4: three sessions show the limit (the same rule as the fifth browser with the default).
    const file = path.join(FX.vault, "brain", "config.json");
    const was = fs.readFileSync(file, "utf8");
    const cfg = JSON.parse(was) as { computer?: Record<string, unknown> };
    fs.writeFileSync(file, JSON.stringify({ ...cfg, computer: { ...(cfg.computer ?? {}), awake: 2 } }));
    const agents: Agent[] = [];
    try {
      const selected = () => h.app.evaluate(() => (globalThis as unknown as { __aosMain: { computerSelected(): string | null } }).__aosMain.computerSelected());
      const pageOf = (k: string) => h.app.evaluate((_a, key) => (globalThis as unknown as { __aosMain: { computerPageId(s?: string): number | null } }).__aosMain.computerPageId(key), k);
      const keys: string[] = [];
      for (const n of [1, 2, 3]) {
        agents.push(await chatAgent(h, { text: `computer: sleep test ${n}` }));
        keys.push((await selected())!);
      }
      // Browsers 1, 2 and 3 were turned on in order and 3 is selected: the one used longest ago (1) is asleep, with no view.
      await expect.poll(() => pageOf(keys[0]), { message: "the least recently used browser has no page" }).toBeNull();
      expect(await pageOf(keys[1])).not.toBeNull();
      expect(await pageOf(keys[2]), "the selected browser never sleeps").not.toBeNull();
      // Selecting the sleeper's thread wakes it (its tabs reload) and puts the next least recently used (2) to sleep.
      await content(win).locator(`.aos-ss-row[data-thread="${keys[0].slice("chat:".length)}"]`).click();
      await expect.poll(selected, { message: "the pane followed to the first session" }).toBe(keys[0]);
      await expect.poll(() => pageOf(keys[0]), { message: "the woken browser has a page again" }).not.toBeNull();
      await expect(pane(win, "chat").locator(".aos-cp-tab").first()).toBeVisible();
      await expect.poll(() => pageOf(keys[1]), { message: "the next least recently used went to sleep" }).toBeNull();
    } finally {
      // The config goes back first: a finish that throws must not leave computer.awake at 2 for the next test.
      fs.writeFileSync(file, was);
      for (const a of agents) await a.finish();
    }
  });

  test("off screen: a Code session's ask badges Code, marks its row waiting, notifies, and the notification and the Notifications item each open the pane on it (D27, D32, D35)", async () => {
    const h = app();
    const { win, app: electron } = h;
    const a = await codeAgent(h, "claude");
    const title = `Act on a site you haven't marked: Click “Add to basket” on ${shopHost()}?`;
    // I1: the notification and the Notifications item carry the ask's app-written notice, never the page's name.
    const notice = `Act on a site you haven't marked: Click on ${shopHost()}?`;
    try {
      await a.call("computer_open", { url: shopUrl() });
      const add = refOf((await a.call("computer_snapshot")).text, "button", "Add to basket");
      const terminal = await win.evaluate(() => (window as unknown as { aosHost: { plugin: { terminalPool: { selectedId(): string | null } } } }).aosHost.plugin.terminalPool.selectedId());
      await openTab(win, "pulse");
      const before = (await notices(electron)).length;
      const held = a.call("computer_click", { ref: add });
      await expect(badge(win, "term")).toHaveText("1");
      await expect.poll(async () => (await notices(electron)).slice(before)).toEqual([
        { title: notice, body: "Claude Code is waiting for your answer in the Computer pane. Open the pane to allow or deny it; with no answer in time it is denied." },
      ]);
      // The desktop notification's click opens Code on that terminal, with the card in its pane.
      await openTab(win, "notifications");
      await electron.evaluate(() => { const n = (globalThis as unknown as { __aosNotified: Array<{ emit(e: string): void }> }).__aosNotified.at(-1); n?.emit("click"); });
      await expect(rail(win, "term")).toHaveClass(/is-active/);
      await expect(content(win).locator(".aos-tl-row.aos-term-tab-active")).toHaveAttribute("data-session", terminal ?? "");
      const p = pane(win, "code");
      await expect(cards(p).locator(".aos-cp-asktitle")).toHaveText([title]);
      const row = content(win).locator(`.aos-tl-row[data-session="${terminal}"]`);
      await expect(row.locator(".aos-tl-waiting")).toHaveText("waiting");
      await expect(row.locator(".aos-tl-cdot.is-waiting")).toHaveAttribute("aria-label", "Asking in the Computer pane");
      // The Notifications item the ask posted (from: computer) has the way back too.
      await openTab(win, "notifications");
      const item = content(win).locator(".aos-nt-row", { has: win.locator(".aos-rt-name > div:first-child", { hasText: notice }) });
      await expect(item).toHaveCount(1);
      await item.click();
      await content(win).locator(".aos-nt-detail button", { hasText: "Open the Computer pane" }).click();
      await expect(rail(win, "term")).toHaveClass(/is-active/);
      await expect(cards(p)).toHaveCount(1);
      await cards(p).locator('[data-answer="deny"]').click();
      expectReply(await held, { isError: true });
      await expect(badge(win, "term")).toHaveText("");
      await expect(row.locator(".aos-tl-waiting")).toHaveCount(0);
    } finally { await a.finish(); }
    expectNoErrors(h);
  });

  test("Take over cancels a pending ask and the next action is refused at once; Hand back gives the wheel back (D31, D23, D27)", async () => {
    const h = app();
    const { win, app: electron } = h;
    const a = await chatAgent(h, { text: "computer: take over" });
    const title = `Act on a site you haven't marked: Click “Add to basket” on ${shopHost()}?`;
    try {
      await a.call("computer_open", { url: shopUrl() });
      const add = refOf((await a.call("computer_snapshot")).text, "button", "Add to basket");
      const thread = await content(win).locator(".aos-ss-row.is-selected").getAttribute("data-thread");
      // Off screen first: the ask badges Sessions and dots the thread's row; its notification opens the thread.
      await openTab(win, "pulse");
      const chain = a.chain({ tool: "computer_click", args: { ref: add } }, { tool: "computer_click", args: { ref: add } });
      await expect(badge(win, "chat")).toHaveText("1");
      await electron.evaluate(() => { const n = (globalThis as unknown as { __aosNotified: Array<{ emit(e: string): void }> }).__aosNotified.at(-1); n?.emit("click"); });
      await expect(rail(win, "chat")).toHaveClass(/is-active/);
      await expect(content(win).locator(".aos-ss-row.is-selected")).toHaveAttribute("data-thread", thread ?? "");
      await expect(content(win).locator(`.aos-ss-row[data-thread="${thread}"] .aos-ss-cdot.is-waiting`)).toHaveCount(1);
      const p = pane(win, "chat");
      await expect(cards(p).locator(".aos-cp-asktitle")).toHaveText([title]);
      // Take over, timed from its click in the page to the refusal of the action the agent sends the moment its held
      // one is cancelled.
      const take = p.locator(".aos-cp-drivebtn");
      await expect(take).toHaveText("Take over");
      await take.evaluate((b) => b.addEventListener("click", () => { (window as unknown as { __tookAt: number }).__tookAt = Date.now(); }, { capture: true, once: true }));
      await take.click();
      const { first, then } = await chain;
      const tookAt = await win.evaluate(() => (window as unknown as { __tookAt: number }).__tookAt);
      expectReply(first, { isError: true, text: `Cancelled because the user took over (Act on a site you haven't marked: Click on ${shopHost()}): call computer_status before you try it again.` });
      expectReply(then, { isError: true, text: "busy: the user is driving: wait for Hand back." });
      const ms = then.at - tookAt;
      console.log(`Take over: the next action was refused ${ms} ms after the click`);
      expect(ms).toBeLessThan(100);
      await expect(cards(p)).toHaveCount(0);
      await expect(p.locator(".aos-cp-drive")).toHaveClass(/is-user/);
      await expect(p.locator(".aos-cp-drivetext")).toHaveText("You're driving");
      expect((await a.call("computer_snapshot")).text).toContain("Basket: empty");
      // Hand back: the wheel returns to the session that held it, and its next click asks again.
      await p.locator(".aos-cp-drivebtn", { hasText: "Hand back" }).click();
      await expect(p.locator(".aos-cp-drive")).toHaveClass(/is-agent/);
      const again = await asked(p, a.call("computer_click", { ref: add }), title);
      await again.card.locator('[data-answer="deny"]').click();
      expectReply(await again.reply, { isError: true });
    } finally { await a.finish(); }
    expectNoErrors(h);
  });

  test("the pointer shows the session's name at a click, in the main window and the pop-out, and is in neither the screenshot nor the outline (session-browser S18)", async () => {
    const h = app();
    const { win, app: electron } = h;
    const name = "computer: pointer";
    const a = await chatAgent(h, { text: name });
    type PointerState = { shown: boolean; at: { x: number; y: number } | null; tag: string; window: "main" | "pop" | null };
    const pointer = (): Promise<PointerState> => electron.evaluate(() => (globalThis as unknown as { __aosMain: { pointer(): PointerState } }).__aosMain.pointer());
    try {
      expectReply(await a.call("computer_open", { url: repoUrl() }), { isError: false });
      const p = pane(win, "chat");
      const details = refOf((await a.call("computer_snapshot")).text, "button", "Show details");
      // The button's centre in the page's viewport, and the view's origin in the window it is in (the pane's view box in the main
      // window; the pop-out's view starts at the window's own origin).
      const centre = () => inPage<{ x: number; y: number }>(electron, repoUrl(), `(() => { const r = document.getElementById("details").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      const viewOrigin = () => p.locator(".aos-cp-view").evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y }; });
      const near = (got: { x: number; y: number } | null, want: { x: number; y: number }, what: string) => {
        expect(got, what).not.toBeNull();
        expect(Math.abs(got!.x - want.x), `${what}: x ${got!.x} vs ${want.x}`).toBeLessThanOrEqual(2);
        expect(Math.abs(got!.y - want.y), `${what}: y ${got!.y} vs ${want.y}`).toBeLessThanOrEqual(2);
      };

      // The main window: the pointer is at the button with the session's name.
      expectReply(await a.call("computer_click", { ref: details }), { isError: false, text: acted(`Clicked ${details}.`, repoUrl()) });
      const c = await centre();
      const o = await viewOrigin();
      const inMain = await pointer();
      expect(inMain.shown).toBe(true);
      expect(inMain.window).toBe("main");
      expect(inMain.tag).toBe(name);
      near(inMain.at, { x: o.x + c.x, y: o.y + c.y }, "the main window");

      // Neither the screenshot (the tab's own capture) nor the outline holds it, while it is shown. Both are looks: the same
      // after it has hidden itself (3 s), byte for byte for the picture.
      const shotShown = await a.call("computer_screenshot");
      const outlineShown = (await a.call("computer_snapshot")).text;
      expect((await pointer()).shown, "still shown while the agent looked").toBe(true);
      expect(shotShown.image).toBeTruthy();
      expect(outlineShown).not.toMatch(/pointer/i);
      await expect.poll(async () => (await pointer()).shown, { timeout: 8_000, message: "it hides itself" }).toBe(false);
      expect((await a.call("computer_screenshot")).image).toBe(shotShown.image);
      expect((await a.call("computer_snapshot")).text).toBe(outlineShown);

      // Take over while it is shown hides it at once.
      expectReply(await a.call("computer_click", { ref: details }), { isError: false });
      expect((await pointer()).shown).toBe(true);
      await p.locator(".aos-cp-drivebtn", { hasText: "Take over" }).click();
      await expect.poll(async () => (await pointer()).shown, { timeout: 1_000 }).toBe(false);
      await p.locator(".aos-cp-drivebtn", { hasText: "Hand back" }).click();

      // The pop-out window: the same, drawn in that window, whose view starts at its origin.
      await p.locator(".aos-cp-popout").click();
      await expect(p).toHaveClass(/is-popped/);
      await expect.poll(() => electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.getTitle().startsWith("UniDeX Browser")).length)).toBe(1);
      expectReply(await a.call("computer_click", { ref: details }), { isError: false });
      const c2 = await centre();
      const inPop = await pointer();
      expect(inPop.shown).toBe(true);
      expect(inPop.window).toBe("pop");
      expect(inPop.tag).toBe(name);
      near(inPop.at, c2, "the pop-out");
    } finally { await a.finish(); }
    expectNoErrors(h);
  });

  test("a process the app did not start is refused at hello; so are a session's second connection and a server behind a shell (D18)", async () => {
    const h = app();
    const outsider = await startOutsider("claude");
    try {
      expectReply(await outsider.agent.call("computer_status"), { isError: true, text: NOT_STARTED });
      expectReply(await outsider.agent.call("computer_open", { url: shopUrl() }), { isError: true, text: NOT_STARTED });
    } finally { outsider.kill(); }
    const a = await chatAgent(h, { text: "computer: outsiders" });
    try {
      expectReply(await a.call("computer_status"), { isError: false });
      expectReply(await a.call("computer_status", {}, "second"), { isError: true, text: "This process's browser tools are not connected because this session already has a computer connection: go on without the browser tools in this process, and tell the user." });
      expectReply(await a.call("computer_status", {}, "grandchild"), { isError: true, text: NOT_STARTED });
      expectReply(await a.call("computer_status"), { isError: false });
    } finally { await a.finish(); }
    expectNoErrors(h);
  });

  test("the Computer tour steps anchor on the pane while the surface is on (tour C8)", async () => {
    const h = app();
    // Sessions' Vault steps need Vault open, as on a Mac where nothing ran yet.
    await openTab(h.win, "chat");
    await content(h.win).locator('.aos-ss-row[data-thread="vault"]').click();
    for (const id of ["code", "sessions"]) {
      const r = await h.win.evaluate((cid) => (window as unknown as { aosHost: { plugin: { tour: { probe(id: string, ms: number): Promise<Array<{ ref: string; status: string }>> } } } }).aosHost.plugin.tour.probe(cid, 10_000), id);
      expect(r.find((x) => x.ref === `${id}.computer`)?.status, `${id}.computer`).toBe("found");
      const lost = r.filter((x) => x.status === "missing" || x.status === "unrouted").map((x) => x.ref);
      // Vault chat has no browser, so on Sessions the pane is its strip, which has no size buttons (session-browser S12).
      expect(lost, `chapter ${id}`).toEqual(id === "sessions" ? ["sessions.computer-size"] : []);
      if (id === "sessions") expect(r.find((x) => x.ref === "sessions.computer-power")?.status).toBe("found");
    }
    expect(TOUR_BOOK.chapters.find((c) => c.id === "code")?.steps.find((s) => s.id === "computer")?.anchor).toBe('[data-tour="computer-view"]');
    expectNoErrors(h);
  });

  test("in a 1024 px window (CI's screen) with the pane open, the composer's host and access menus open inside Sessions' narrow reader, so either host can be picked", async () => {
    const h = app();
    const { win, app: electron } = h;
    await resizeHud(electron, { width: 1024, height: 740 });
    try {
      await openTab(win, "chat");
      await content(win).locator(".aos-ss-newbtn").click();
      await expect(reader(win).locator(".aos-ss-toptitle")).toHaveText("New session");
      await expect(pane(win, "chat")).toBeVisible();
      // The reader clips what overflows it: a menu that ran past its edge had that part under the list or the pane.
      const inside = async (menu: Locator): Promise<void> => {
        const [box, pop] = await Promise.all([reader(win).boundingBox(), menu.boundingBox()]);
        expect(!!box && !!pop && pop.x >= box.x && pop.x + pop.width <= box.x + box.width, JSON.stringify({ reader: box, menu: pop })).toBe(true);
      };
      const hm = reader(win).locator(".aos-ss-toolbar .aos-hm");
      for (const host of ["codex", "claude"] as const) {
        await hm.locator(".aos-hm-trigger").click();
        await inside(hm.locator(".aos-hm-pop"));
        await hm.locator(`.aos-hm-pop .aos-hm-host[data-host="${host}"]`).click();
        await hm.locator(".aos-hm-pop .aos-hm-search").press("Escape");
        await expect(hm.locator(".aos-hm-trigger")).toHaveAttribute("data-host", host);
      }
      const am = reader(win).locator(".aos-ss-toolbar .aos-am");
      await am.locator(".aos-am-trigger").click();
      await inside(am.locator(".aos-am-menu"));
      await am.locator('.aos-am-item[data-level="edit"]').click();
      await expect(am).toHaveAttribute("data-access", "edit");
    } finally { await resizeHud(electron, { width: 1480, height: 920 }); }
    expectNoErrors(h);
  });

  test("on Sessions an open pane gives way as the window narrows: the reader keeps 360 px and nothing overflows", async () => {
    const h = app();
    const { win, app: electron } = h;
    // A thread has a browser, so the pane measured is a followed one (a new, unsent session follows nothing).
    const thread = await chatAgent(h, { text: "computer: gives way" });
    try {
      await openTab(win, "chat");
      await expect(pane(win, "chat")).toBeVisible();
      await expect(pane(win, "chat").locator(".aos-cp-tabnew")).toBeEnabled();
      const measured: Record<number, { reader: number; pane: number; overflow: number }> = {};
      for (const width of [1100, 900]) {
        // The page's width once the window has settled: the window's own, which may be held above or below the one asked.
        const want = await resizeAndSettle(electron, win, { width, height: 740 });
        const m = await content(win).locator(".aos-ss").evaluate((root) => {
          const w = (sel: string) => Math.round((root.querySelector(sel) as HTMLElement).getBoundingClientRect().width);
          return { reader: w(".aos-ss-reader"), pane: w(".aos-cp"), overflow: Math.max(root.scrollWidth - root.clientWidth, root.ownerDocument.documentElement.scrollWidth - root.ownerDocument.documentElement.clientWidth) };
        });
        measured[width] = m;
        const at = `${width} (page ${want}): ${JSON.stringify(m)}`;
        expect(m.reader, at).toBeGreaterThanOrEqual(360);
        expect(m.overflow, at).toBeLessThanOrEqual(0);
      }
      expect(measured[900].pane, `the pane at 900 is no wider than at 1100: ${JSON.stringify(measured)}`).toBeLessThanOrEqual(measured[1100].pane);
    } finally { await resizeHud(electron, { width: 1480, height: 920 }); await thread.finish(); }
    expectNoErrors(h);
  });

  test("at its narrowest the pane's header and address row still fit (session-browser S11)", async () => {
    const h = app();
    const { win, app: electron } = h;
    /** Holds the pane compact, the address input at least 96 px, every displayed part of the header and of the address row
     *  inside the pane's own edges, and the place label at least 24 px wide. */
    const fits = async (p: Locator, at: string): Promise<void> => {
      await expect(p, at).toHaveClass(/is-compact/);
      await expect.poll(async () => p.evaluate((root) => {
        const edge = root.getBoundingClientRect();
        const shown = (el: Element): boolean => getComputedStyle(el).display !== "none";
        const outside = (parent: Element | null): string[] => [...(parent?.children ?? [])].filter(shown).flatMap((el) => {
          const r = el.getBoundingClientRect();
          return r.left >= edge.left - 0.5 && r.right <= edge.right + 0.5 ? [] : [`${el.className || el.tagName}: ${Math.round(r.left)}..${Math.round(r.right)} outside ${Math.round(edge.left)}..${Math.round(edge.right)}`];
        });
        const w = (sel: string): number => Math.round(root.querySelector(sel)?.getBoundingClientRect().width ?? 0);
        return JSON.stringify({ pane: Math.round(edge.width), url: w(".aos-cp-url"), place: w(".aos-cp-place"), outside: [...outside(root.querySelector(".aos-cp-head")), ...outside(root.querySelector("form.aos-cp-address"))] });
      }), { message: at }).toEqual(expect.stringMatching(/"outside":\[\]/));
      const m = JSON.parse(await p.evaluate((root) => {
        const w = (sel: string): number => Math.round(root.querySelector(sel)?.getBoundingClientRect().width ?? 0);
        return JSON.stringify({ url: w(".aos-cp-url"), place: w(".aos-cp-place") });
      })) as { url: number; place: number };
      expect(m.url, `${at}: the address input is ${m.url} px`).toBeGreaterThanOrEqual(96);
      expect(m.place, `${at}: the place label is ${m.place} px`).toBeGreaterThanOrEqual(24);
    };
    const narrowTo = async (width: number): Promise<void> => { await resizeAndSettle(electron, win, { width, height: 740 }); };
    const a = await codeAgent(h, "claude");
    const code = pane(win, "code");
    const bar = code.locator(".aos-cp-handle");
    try {
      await code.locator(".aos-cp-tabnew").click();
      await expect(code.locator(".aos-cp-trust")).toHaveText(`Asks first on ${searchHost()}`);
      // (a) Code: the person's way to the pane's least width, the bar's arrow key.
      await bar.focus();
      for (let i = 0; i < 40 && (await bar.getAttribute("aria-valuenow")) !== "320"; i++) await bar.press("ArrowRight");
      await expect(bar).toHaveAttribute("aria-valuenow", "320");
      await expect.poll(() => code.evaluate((root) => Math.round(root.getBoundingClientRect().width)), { message: "the pane is drawn 320 px wide" }).toBe(320);
      await fits(code, "Code, pane at 320");
    } finally {
      await bar.dispatchEvent("dblclick");
      await a.finish();
    }
    let thread: Agent | undefined;
    try {
      // (b) Sessions at the window's least width, where the layout squeezes the pane below 320.
      // A thread has a browser (a new, unsent session has none): start one through the fake CLI.
      thread = await chatAgent(h, { text: "computer: narrowest" });
      await openTab(win, "chat");
      const chat = pane(win, "chat");
      await expect(chat).toBeVisible();
      await chat.locator(".aos-cp-tabnew").click();
      await expect(chat.locator(".aos-cp-trust")).toHaveText(`Asks first on ${searchHost()}`);
      await narrowTo(100);
      await fits(chat, "Sessions, the window at its least width");
    } finally {
      await resizeHud(electron, { width: 1480, height: 920 });
      await thread?.finish();
    }
    expectNoErrors(h);
  });

  test("quitting with a computer open and the pane popped out ends the app at once (R46)", async () => {
    const h = app();
    const { win, app: electron } = h;
    const a = await chatAgent(h, { text: "computer: quit" });
    expectReply(await a.call("computer_open", { url: shopUrl() }), { isError: false });
    const p = pane(win, "chat");
    await p.locator(".aos-cp-popout").click();
    await expect(p).toHaveClass(/is-popped/);
    // session-browser S21: the pop-out window is named for the session whose browser it holds (the thread's title).
    await expect.poll(() => electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.getTitle() === "UniDeX Browser: computer: quit").length)).toBe(1);
    const proc = electron.process();
    const marker = () => JSON.parse(fs.readFileSync(FX.v("brain/_index/hud-host.json"), "utf8")) as Record<string, unknown>;
    expect(marker()).toMatchObject({ pid: proc.pid, computerSocket: expect.any(String) });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => proc.once("exit", (code, signal) => resolve({ code, signal })));
    const t0 = Date.now();
    await electron.evaluate(({ app: electronApp }) => { setTimeout(() => electronApp.quit(), 0); });
    const done = await Promise.race([exited, new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000))]);
    expect(done, "the app quit by itself within 10 s").toEqual({ code: 0, signal: null });
    console.log(`quit with a computer and a pop-out open: ${Date.now() - t0} ms`);
    // The turn's agent goes with the app (main stops every turn on quit).
    const gone = async (): Promise<boolean> => { try { process.kill(a.run.pid, 0); return false; } catch { return true; } };
    await expect.poll(gone, { timeout: 10_000, message: "the agent's process ended" }).toBe(true);
    // The marker keeps no Computer state past the app, so an agent asking now hears the app is not running.
    expect(Object.keys(marker()).filter((k) => k.startsWith("computer"))).toEqual([]);
  });
});

// ── one browser per session, off until the user turns it on ──────────

test.describe("session browser: one per session, off until the user turns it on (session-browser §6, PR 3)", () => {
  const env: Record<string, string | undefined> = { AOS_APP_WRITE: "computer,sessions", ...computerEnv() };
  test.beforeAll(async () => { site = await startSite(); env.AOS_E2E_START_PAGE = startUrl(); });
  test.afterAll(async () => { await site?.close(); });
  const app = useApp({
    env,
    prepare: () => { prepare({ claude: true, codex: true }); markSite(`http://marked.test:${site.port}`); },
  });
  const mainOf = (h: { app: ElectronApplication }) => ({
    selected: () => h.app.evaluate(() => (globalThis as unknown as { __aosMain: { computerSelected(): string | null } }).__aosMain.computerSelected()),
    pageId: (key: string) => h.app.evaluate((_e, k) => (globalThis as unknown as { __aosMain: { computerPageId(s?: string): number | null } }).__aosMain.computerPageId(k), key),
  });
  const tabLines = (r: { text: string }) => r.text.split("\n").filter((l) => /^ {2}\[\d+\]/.test(l)).join("\n");

  test("two sessions in one folder have separate tabs and neither is busy", async () => {
    const h = app();
    const { win } = h;
    const first = await codeAgent(h, "claude");
    const firstTerminal = await win.evaluate(() => (window as unknown as { aosHost: { plugin: { terminalPool: { selectedId(): string | null } } } }).aosHost.plugin.terminalPool.selectedId());
    const second = await codeAgent(h, "codex");
    try {
      expectReply(await first.call("computer_open", { url: shopUrl() }), { isError: false });
      expectReply(await second.call("computer_open", { url: repoUrl() }), { isError: false });
      expect(tabLines(await first.call("computer_status"))).toContain(shopHost());
      expect(tabLines(await first.call("computer_status"))).not.toContain(markedHost());
      expect(tabLines(await second.call("computer_status"))).toContain(markedHost());
      expect(tabLines(await second.call("computer_status"))).not.toContain(shopHost());
      // The pane follows the second session: hold an ask there (a click on an unmarked site), as it works the first is not refused as busy.
      expectReply(await first.call("computer_open", { url: shopUrl() }), { isError: false });
      const ref = refOf((await first.call("computer_snapshot")).text, "button", "Add to basket");
      const p = pane(win, "code");
      const noticesBefore = (await notices(h.app)).length;
      const held = first.call("computer_click", { ref });
      held.catch(() => undefined); // a failure below must not surface as an unhandled rejection
      // The first session's ask is pending once main has noticed it off-screen (the pane shows the second session): the
      // same desktop notice the test "off screen: a Code session's ask badges Code…" polls.
      await expect.poll(async () => (await notices(h.app)).length, { message: "the first session's ask is pending (noticed off-screen)" }).toBeGreaterThan(noticesBefore);
      await expect(cards(p)).toHaveCount(0); // the pane shows the second session; the first's card is not here
      const other = await second.call("computer_status");
      expectReply(other, { isError: false });
      expect(other.text).not.toMatch(/busy/i);
      expectReply(await second.call("computer_snapshot"), { isError: false });
      // Settle the held ask before the agents finish: bring the first session back in front and deny its card.
      await content(win).locator(`.aos-tl-row[data-session="${firstTerminal}"]`).click();
      await expect(cards(p)).toHaveCount(1);
      await cards(p).locator('[data-answer="deny"]').click();
      expectReply(await held, { isError: true });
    } finally { await first.finish(); await second.finish(); }
    expectNoErrors(h);
  });

  test("a new session's open shows the Turn on card; Not now is reported and a retry shows no card; turned on by hand the next call works with no card", async () => {
    const h = app();
    const { win } = h;
    const a = await codeAgent(h, "claude", { surfaceOff: true });
    try {
      const p = pane(win, "code");
      const open = a.call("computer_open", { url: shopUrl() });
      await expect(cards(p)).toHaveCount(1);
      await expect(cards(p).locator('[data-answer="once"]')).toHaveText("Turn on");
      await expect(cards(p).locator('[data-answer="deny"]')).toHaveText("Not now");
      await cards(p).locator('[data-answer="deny"]').click();
      expectReply(await open, { isError: true, text: /The user declined to turn the browser on/ });
      await expect(cards(p)).toHaveCount(0);
      expectReply(await a.call("computer_open", { url: shopUrl() }), { isError: true, text: /The user declined to turn the browser on/ });
      await expect(cards(p)).toHaveCount(0);
      // By hand: the strip's power button when the pane is a strip, else the header's switch.
      const strip = p.locator("button.aos-cp-strip-power");
      if (await strip.count()) await strip.click();
      else await p.locator('button.aos-cp-power[role="switch"]').click();
      await expect(p.locator('button.aos-cp-power[role="switch"]')).toHaveText("On");
      expectReply(await a.call("computer_open", { url: shopUrl() }), { isError: false, text: acted(`Opened the page.`, shopUrl()) });
      await expect(cards(p)).toHaveCount(0);
    } finally { await a.finish(); }
    expectNoErrors(h);
  });

  test("Off closes the tabs and stops typing in flight; closing the last tab switches off; On reopens them", async () => {
    const h = app();
    const { win } = h;
    const a = await codeAgent(h, "claude");
    try {
      const p = pane(win, "code");
      const sw = p.locator('button.aos-cp-power[role="switch"]');
      expectReply(await a.call("computer_open", { url: shopUrl() }), { isError: false });
      const trust = p.locator(".aos-cp-trust");
      await trust.click();
      await expect(trust).toHaveText(`Acts freely on ${shopHost()}`);
      await p.locator(".aos-cp-tabnew").click();
      await expect(p.locator(".aos-cp-tab")).toHaveCount(2);
      await p.locator(".aos-cp-tab").first().click();
      await expect(p.locator(".aos-cp-tab").first()).toHaveClass(/is-active/);
      const field = refOf((await a.call("computer_snapshot")).text, "textbox", "Search");
      const before = await a.call("computer_status");
      expect(tabLines(before)).toContain(shopHost());
      expect(tabLines(before)).toContain(searchHost()); // the + opens the start page
      const typing = a.call("computer_type", { text: "rope ".repeat(800), ref: field });
      await expect(p.locator(".aos-cp-acting")).toHaveText(/^Acting: /);
      await sw.click();
      expectReply(await typing, { isError: true, text: /The user switched the browser off/ });
      await expect(p).toHaveClass(/is-collapsed/);
      await expect(p.locator("button.aos-cp-strip-power")).toBeVisible();
      expect((await a.call("computer_status")).text).toContain("(off:");
      // On: the same two addresses come back.
      await p.locator("button.aos-cp-strip-power").click();
      await expect(p.locator(".aos-cp-tab")).toHaveCount(2);
      // A reopened tab reads about:blank until its page commits, so the addresses are polled for.
      await expect.poll(async () => tabLines(await a.call("computer_status")), { message: "both addresses are back" }).toContain(searchHost());
      expect(tabLines(await a.call("computer_status"))).toContain(shopHost());
      // Closing the tabs, to the last: the browser is off.
      await p.locator(".aos-cp-tab .aos-cp-tabclose").first().click();
      await expect(p.locator(".aos-cp-tab")).toHaveCount(1);
      await p.locator(".aos-cp-tab .aos-cp-tabclose").first().click();
      await expect(p.locator("button.aos-cp-strip-power")).toBeVisible();
      expect((await a.call("computer_status")).text).toContain("(off:");
    } finally { await a.finish(); }
    expectNoErrors(h);
  });

  test("Close session and Delete thread forget the browser", async () => {
    const h = app();
    const { win } = h;
    const m = mainOf(h);
    const code = await codeAgent(h, "claude");
    try {
      expectReply(await code.call("computer_open", { url: shopUrl() }), { isError: false });
      const key = (await m.selected()) as string;
      expect(key).toMatch(/^code:/);
      expect(await m.pageId(key)).not.toBeNull();
      const row = content(win).locator(".aos-tl-row.aos-term-tab-active");
      await row.hover();
      await row.locator(".aos-tl-close").click();
      // The agent is still running: closing asks first.
      const modal = win.locator(".aos-confirm-modal");
      await expect(modal.locator("h3")).toHaveText("Close this terminal?");
      await modal.getByRole("button", { name: "Close" }).click();
      await expect.poll(() => m.pageId(key), { message: "the closed terminal's browser is forgotten" }).toBeNull();
    } finally { await code.finish(); }
    const chatRun = await chatAgent(h, { text: "computer: delete thread forgets" });
    try {
      expectReply(await chatRun.call("computer_open", { url: shopUrl() }), { isError: false });
      const key = (await m.selected()) as string;
      expect(key).toMatch(/^chat:/);
      expect(await m.pageId(key)).not.toBeNull();
      await chatRun.finish();
      await expect(doneLines(win)).toHaveCount(1);
      await reader(win).locator(".aos-ss-delete").click();
      await win.locator(".aos-confirm-modal").getByRole("button", { name: "Delete" }).click();
      await expect.poll(() => m.pageId(key), { message: "the deleted thread's browser is forgotten" }).toBeNull();
    } finally { await chatRun.finish().catch(() => undefined); }
    expectNoErrors(h);
  });

  // The model chip's own flow (launch the replacement, wait for it, hand over, close the old one) is `restartKeepingOld`, covered by its
  // unit tests and by code-chat.spec's chip test. This test covers what the handoff does to the browser in the real app: the page hands
  // the old terminal's browser to the replacement (`aos.computer.move`), then the old terminal closes.
  test("a hand-over to the replacement terminal keeps the browser on with its page not reloaded", async () => {
    const h = app();
    const { win } = h;
    const m = mainOf(h);
    const termId = () => win.evaluate(() => (window as unknown as { aosHost: { plugin: { terminalPool: { selectedId(): string | null } } } }).aosHost.plugin.terminalPool.selectedId());
    const a = await codeAgent(h, "claude");
    const keyA = (await m.selected()) as string;
    const terminalA = await termId();
    const b = await codeAgent(h, "claude", { surfaceOff: true });
    try {
      const url = `http://shop.test:${site.port}/count.html`;
      expectReply(await a.call("computer_open", { url }), { isError: false });
      const loads = () => site.seen.filter((x) => x.url === "/count.html").length;
      expect(loads()).toBe(1);
      expect(await inPage<string>(h.app, url, "document.body.innerText", keyA)).toContain("Loads: 1");
      await expect.poll(async () => { const k = await m.selected(); return k !== null && k !== keyA; }, { message: "the pane selected the second agent" }).toBe(true);
      const keyB = (await m.selected()) as string;
      expect(keyB).toMatch(/^code:/);
      // The handoff, as the page makes it (preload: move answers whether a browser moved).
      const moved = await win.evaluate(([from, to]) => (window as unknown as { aos: { computer: { move(a: string, c: string): Promise<boolean> } } }).aos.computer.move(from, to), [keyA, keyB]);
      expect(moved).toBe(true);
      // Then the old terminal closes (its agent is running, so the close is confirmed).
      const rowA = content(win).locator(`.aos-tl-row[data-session="${terminalA}"]`);
      await rowA.hover();
      await rowA.locator(".aos-tl-close").click();
      const modal = win.locator(".aos-confirm-modal");
      await expect(modal.locator("h3")).toHaveText("Close this terminal?");
      await modal.getByRole("button", { name: "Close" }).click();
      await expect(rowA).toHaveCount(0);
      await expect.poll(() => m.selected(), { message: "the pane is on the replacement" }).toBe(keyB);
      const p = pane(win, "code");
      await expect(p.locator('button.aos-cp-power[role="switch"]')).toHaveText("On");
      await expect(p.locator(".aos-cp-tab.is-active")).toContainText("Loads");
      expect(tabLines(await b.call("computer_status"))).toContain("count.html");
      expect(await inPage<string>(h.app, url, "document.body.innerText", keyB)).toContain("Loads: 1");
      expect(loads(), "the page was loaded once: the hand-over does not reload it").toBe(1);
    } finally { await a.finish(); await b.finish(); }
    expectNoErrors(h);
  });
});

// ── the four tools of the thirteen: computer_tab, computer_nav, computer_hover, computer_console, and a double click ───

test.describe("session browser: tab, nav, hover and console, on both hosts (session-browser S16, S17)", () => {
  const env: Record<string, string | undefined> = { AOS_APP_WRITE: "computer,sessions", ...computerEnv() };
  test.beforeAll(async () => { site = await startSite(); env.AOS_E2E_START_PAGE = startUrl(); });
  test.afterAll(async () => { await site?.close(); });
  const app = useApp({
    env,
    prepare: () => { prepare({ claude: true, codex: true }); markSite(`http://marked.test:${site.port}`); },
  });
  const toolsUrl = () => `http://marked.test:${site.port}/tools.html`;
  const orderUrl = () => `http://marked.test:${site.port}/order.html`;
  const tabLines = (r: { text: string }) => r.text.split("\n").filter((l) => /^ {2}\[\d+\]/.test(l)).join("\n");
  /** The index a status line gives the tab at `host`: `  [1] …`. */
  const tabIndexOf = (lines: string, host: string): number => {
    const m = lines.split("\n").map((l) => /^ {2}\[(\d+)\]/.exec(l)).find((x, i) => x && lines.split("\n")[i].includes(host));
    if (!m) throw new Error(`no tab at ${host} in:\n${lines}`);
    return Number(m[1]);
  };
  const hits = (urlPath: string, method = "GET"): number => site.seen.filter((x) => x.method === method && x.url === urlPath).length;

  test("computer_tab, computer_nav, computer_hover and computer_console work through the bridge", async () => {
    const h = app();
    const { win } = h;
    for (const host of ["claude", "codex"] as const) {
      const a = await chatAgent(h, { host, text: `computer: four tools on ${host}` });
      try {
        const p = pane(win, "chat");
        expectReply(await a.call("computer_open", { url: shopUrl() }), { isError: false, text: acted("Opened the page.", shopUrl()) });
        // A second tab, opened by the agent: switching to it and closing it ask nothing.
        expectReply(await a.call("computer_open", { url: toolsUrl(), newTab: true }), { isError: false, text: acted("Opened the page.", toolsUrl()) });
        const tabs = tabLines(await a.call("computer_status"));
        expect(tabs).toContain(shopHost());
        expect(tabs).toContain(markedHost());
        // Switching away and back: the reply is the page the tab shows.
        const second = tabIndexOf(tabs, markedHost());
        const firstTab = tabIndexOf(tabs, shopHost());
        expectReply(await a.call("computer_tab", { index: firstTab }), { isError: false, text: acted(`Switched to tab ${firstTab}.`, shopUrl()) });
        const onTools = await a.call("computer_tab", { index: second });
        expectReply(onTools, { isError: false, text: acted(`Switched to tab ${second}.`, toolsUrl()) });
        await expect(cards(p)).toHaveCount(0);
        // The console: what the page wrote when it loaded, as page text.
        const log = await a.call("computer_console");
        expectReply(log, { isError: false });
        expect(log.text).toContain("<untrusted-page");
        expect(log.text).toContain("fixture console error");
        expect(log.text).toContain("fixture console warning");
        // Hover moves the pointer only: the page shows what its hover handler shows, and a double click is two clicks.
        // The refs come from the REPLY of the call before (the switch's, then the hover's), never from a snapshot: an action's
        // reply ends with the page, so the next call can use what it names (session-browser S16).
        expect(onTools.text).toContain("Menu closed");
        const menu = refOf(onTools.text, "button", "Menu");
        const hovered = await a.call("computer_hover", { ref: menu });
        expectReply(hovered, { isError: false, text: acted(`Hovered ${menu}.`, toolsUrl()) });
        // The page itself is read (not a snapshot, which would give the refs again): the hover handler ran, and the pointer
        // did not click, so Menu's click counter is still at zero.
        await expect.poll(() => inPage<string>(h.app, toolsUrl(), `document.getElementById("menu-state").textContent`), { message: "the hover handler ran" }).toBe("Menu open");
        expect(await inPage<string>(h.app, toolsUrl(), `document.getElementById("menu-clicks").textContent`), "a hover is not a click").toBe("Menu clicks: 0");
        const count = refOf(hovered.text, "button", "Count");
        expectReply(await a.call("computer_click", { ref: count, double: true }), { isError: false, text: acted(`Double-clicked ${count}.`, toolsUrl()) });
        await expect.poll(async () => (await a.call("computer_snapshot")).text, { message: "the double click ran" }).toContain("Double: yes");
        // Back, Forward and Reload of a page loaded by GET go without asking.
        expectReply(await a.call("computer_open", { url: shopUrl() }), { isError: false });
        expectReply(await a.call("computer_nav", { go: "back" }), { isError: false, text: acted("Went back.", toolsUrl()) });
        expectReply(await a.call("computer_nav", { go: "forward" }), { isError: false, text: acted("Went forward.", shopUrl()) });
        const before = hits("/shop.html");
        expectReply(await a.call("computer_nav", { go: "reload" }), { isError: false, text: acted("Reloaded.", shopUrl()) });
        expect(hits("/shop.html")).toBeGreaterThan(before);
        await expect(cards(p)).toHaveCount(0);
        // Closing the tab the agent opened (the second) asks nothing.
        expectReply(await a.call("computer_tab", { index: second, close: true }), { isError: false, text: /^Closed the tab\.\n\nPage now:/ });
        await expect(cards(p)).toHaveCount(0);
        // The first tab is the one the switch opened for the person (the agent only navigated it): closing it asks, and as the last tab it leaves the browser on.
        const held = await asked(p, a.call("computer_tab", { index: 0, close: true }), /^Close a tab it did not open: /);
        await held.card.locator('[data-answer="once"]').click();
        expectReply(await held.reply, { isError: false, text: /^Closed the tab\.\n\nPage now:/ });
        const after = await a.call("computer_status");
        expectReply(after, { isError: false });
        expect(after.text).not.toMatch(/off: computer_open asks/);
        await expect.poll(async () => tabLines(await a.call("computer_status")), { message: "the start page replaced it" }).toContain(searchHost());
        // (b) The start tab that close left is not the agent's own (S5 leaves it to the person): closing it asks, and Deny keeps it.
        const startTab = await asked(p, a.call("computer_tab", { index: 0, close: true }), /^Close a tab it did not open: /);
        await startTab.card.locator('[data-answer="deny"]').click();
        expectReply(await startTab.reply, { isError: true, text: /^The user denied it/ });
        expect(tabLines(await a.call("computer_status")), "Deny closed nothing: the start tab is still there").toContain(searchHost());
        // (a) A tab the agent opens as a NEW tab is its own. With the start tab (the person's) closed on Allow, it is the last tab:
        // the agent's close of it asks nothing, and the browser stays on with one new tab at the start page.
        expectReply(await a.call("computer_open", { url: toolsUrl(), newTab: true }), { isError: false, text: acted("Opened the page.", toolsUrl()) });
        const both = tabLines(await a.call("computer_status"));
        expect(both).toContain(searchHost());
        expect(both).toContain(markedHost());
        const closeStart = await asked(p, a.call("computer_tab", { index: tabIndexOf(both, searchHost()), close: true }), /^Close a tab it did not open: /);
        await closeStart.card.locator('[data-answer="once"]').click();
        expectReply(await closeStart.reply, { isError: false, text: /^Closed the tab\.\n\nPage now:/ });
        const onlyOwn = tabLines(await a.call("computer_status"));
        expect(onlyOwn, "the agent's own tab is the only one").toContain(markedHost());
        expect(onlyOwn.split("\n")).toHaveLength(1);
        const closedLast = await a.call("computer_tab", { index: 0, close: true });
        expectReply(closedLast, { isError: false, text: /^Closed the tab\.\n\nPage now:/ });
        await expect(cards(p)).toHaveCount(0);
        // What differs across the close: the page that was closed is gone from the one tab's line, and the start page is in front.
        await expect.poll(async () => tabLines(await a.call("computer_status")), { message: "one new tab at the start page" }).toContain(searchHost());
        const after2 = tabLines(await a.call("computer_status"));
        expect(after2).not.toContain(markedHost());
        expect(after2.split("\n")).toHaveLength(1);
        const last = await a.call("computer_status");
        expectReply(last, { isError: false });
        expect(last.text).not.toMatch(/off: computer_open asks/);
      } finally { await a.finish(); }
    }
    expectNoErrors(h);
  });

  test("a reload after a form POST asks and a reload of a GET page does not", async () => {
    const h = app();
    const { win } = h;
    for (const host of ["claude", "codex"] as const) {
      const a = await chatAgent(h, { host, text: `computer: reload asks after a post on ${host}` });
      try {
        const p = pane(win, "chat");
        const posts = () => hits("/order", "POST");
        expectReply(await a.call("computer_open", { url: orderUrl() }), { isError: false, text: acted("Opened the page.", orderUrl()) });
        // A page loaded by GET: Reload loads it again with no card.
        const before = hits("/order.html");
        expectReply(await a.call("computer_nav", { go: "reload" }), { isError: false, text: acted("Reloaded.", orderUrl()) });
        expect(hits("/order.html")).toBeGreaterThan(before);
        await expect(cards(p)).toHaveCount(0);
        // The form posts (the spec submits it in the page, as the person would); the page that loads is the answer to a POST.
        const sent = posts();
        await inPage<void>(h.app, orderUrl(), `document.getElementById("place").click()`);
        await expect.poll(posts, { message: "the form posted" }).toBe(sent + 1);
        const resultUrl = `http://marked.test:${site.port}/order`;
        await expect.poll(() => inPage<string>(h.app, resultUrl, "document.title"), { message: "the answer loaded" }).toBe("Ordered");
        // Reload now would send the form again: it asks, and Deny sends nothing.
        const title = /^Load a page again, which may send a form again: Reload on /;
        const denied = await asked(p, a.call("computer_nav", { go: "reload" }), title);
        await denied.card.locator('[data-answer="deny"]').click();
        expectReply(await denied.reply, { isError: true, text: /^The user denied it/ });
        expect(posts()).toBe(sent + 1);
        // Allow once sends it again.
        const allowed = await asked(p, a.call("computer_nav", { go: "reload" }), title);
        await allowed.card.locator('[data-answer="once"]').click();
        expectReply(await allowed.reply, { isError: false, text: acted("Reloaded.", resultUrl) });
        expect(posts()).toBe(sent + 2);
        await expect(cards(p)).toHaveCount(0);
      } finally { await a.finish(); }
    }
    expectNoErrors(h);
  });
});

// ── kept, limited, linked and popped out ─────────────────────────────

test.describe("session browser: kept, limited, linked and popped out (session-browser §6, PR 3)", () => {
  const env: Record<string, string | undefined> = { AOS_APP_WRITE: "computer,sessions", ...computerEnv() };
  test.beforeAll(async () => { site = await startSite(); env.AOS_E2E_START_PAGE = startUrl(); });
  test.afterAll(async () => { await site?.close(); });
  const app = useApp({
    env,
    prepare: () => { prepare({ claude: true, codex: true }); markSite(`http://marked.test:${site.port}`); seedLinkThread(); },
  });
  const LINK_THREAD = "5e5510f1-0a11-4b1e-8c1d-0123456789ab";
  /** A Sessions thread on disk (no agent): one prompt and one reply whose text links to the shop fixture page. */
  const seedLinkThread = (): void => {
    const file = FX.v(`brain/_index/sessions/${WS}/${LINK_THREAD}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const t = (n: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, n)).toISOString();
    const lines = [
      { schema: 1, kind: "meta", thread: LINK_THREAD, workspace: WS, host: "claude", model: null, effort: null, access: "read", title: "Links in a thread", created: t(0) },
      { t: t(1), kind: "prompt", text: "where is the shop", model: null, effort: null, access: "read" },
      { t: t(2), kind: "text", text: `The shop is [open the shop](${shopUrl()}) today.` },
      { t: t(3), kind: "done", ok: true, usd: null, estimated: false },
    ];
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  };
  const externalOf = (electron: ElectronApplication) =>
    electron.evaluate(() => (globalThis as unknown as { __aosMain: { externalOpens(): Array<{ url: string; opened: boolean }> } }).__aosMain.externalOpens());
  const selectedOf = (h: { app: ElectronApplication }) => h.app.evaluate(() => (globalThis as unknown as { __aosMain: { computerSelected(): string | null } }).__aosMain.computerSelected());
  const pageOf = (h: { app: ElectronApplication }, key: string) => h.app.evaluate((_e, k) => (globalThis as unknown as { __aosMain: { computerPageId(s?: string): number | null } }).__aosMain.computerPageId(k), key);
  const tabLines = (r: { text: string }) => r.text.split("\n").filter((l) => /^ {2}\[\d+\]/.test(l)).join("\n");
  const browserTitles = (electron: ElectronApplication) =>
    electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.getTitle().startsWith("UniDeX Browser")).map((w) => w.getTitle()));

  test("after the page reloads, the pane follows back to the thread and shows its tabs", async () => {
    const h = app();
    const { win } = h;
    const a = await chatAgent(h, { text: "computer: reload keeps tabs" });
    try {
      const key = (await selectedOf(h)) as string;
      expect(key).toMatch(/^chat:/);
      expectReply(await a.call("computer_open", { url: shopUrl() }), { isError: false });
      expectReply(await a.call("computer_open", { url: repoUrl(), newTab: true }), { isError: false });
      await expect.poll(async () => tabLines(await a.call("computer_status")), { message: "both addresses" }).toContain(markedHost());
      const lines = tabLines(await a.call("computer_status"));
      const count = lines.split("\n").length;
      expect(lines).toContain(shopHost());
      await win.reload();
      await openTab(win, "chat");
      await content(win).locator(`.aos-ss-row[data-thread="${key.slice("chat:".length)}"]`).click();
      await expect.poll(() => selectedOf(h), { message: "the pane followed to the thread" }).toBe(key);
      await expect(pane(win, "chat").locator(".aos-cp-tab")).toHaveCount(count);
      await expect(pane(win, "chat").locator('button.aos-cp-power[role="switch"]')).toHaveText("On");
      // win.reload() reloads only the page: main keeps the slot, so this does not read the record file back (the relaunch test below does).
    } finally { await a.finish().catch(() => undefined); }
    expectNoErrors(h);
  });

  test("browsers kept awake over the limit while their agents hold them go back under it when a hold ends (session-browser S9)", async () => {
    const h = app();
    // computer.awake 2 instead of 4. Each agent's open takes its browser's wheel, and a held browser is never put to sleep, so
    // all three stay awake over the limit; when the first agent's turn ends its hold goes, and the limit applies again.
    const file = path.join(FX.vault, "brain", "config.json");
    const was = fs.readFileSync(file, "utf8");
    const cfg = JSON.parse(was) as { computer?: Record<string, unknown> };
    fs.writeFileSync(file, JSON.stringify({ ...cfg, computer: { ...(cfg.computer ?? {}), awake: 2 } }));
    const agents: Agent[] = [];
    try {
      const keys: string[] = [];
      for (const n of [1, 2, 3]) {
        const a = await chatAgent(h, { text: `computer: limit with pages ${n}` });
        agents.push(a);
        keys.push((await selectedOf(h)) as string);
        expectReply(await a.call("computer_open", { url: shopUrl() }), { isError: false });
      }
      for (const k of keys) expect(await pageOf(h, k), `${k} is awake while its agent holds it`).not.toBeNull();
      await agents[0].finish();
      await expect.poll(() => pageOf(h, keys[0]), { message: "the released, least recently used browser went to sleep" }).toBeNull();
      expect(await pageOf(h, keys[2]), "the selected browser never sleeps").not.toBeNull();
    } finally {
      for (const a of agents) await a.finish().catch(() => undefined);
      fs.writeFileSync(file, was);
    }
    expectNoErrors(h);
  });

  test("a link in a thread opens once, in that thread's browser, and nothing opens outside", async () => {
    const h = app();
    const { win } = h;
    await openTab(win, "chat");
    await content(win).locator(`.aos-ss-row[data-thread="${LINK_THREAD}"]`).click();
    await expect.poll(() => selectedOf(h), { message: "the pane followed to the thread" }).toBe(`chat:${LINK_THREAD}`);
    const before = (await externalOf(h.app)).length;
    const link = reader(win).locator(`a[href="${shopUrl()}"]`);
    await link.click();
    await expect(pane(win, "chat").locator('button.aos-cp-power[role="switch"]')).toHaveText("On");
    await expect(pane(win, "chat").locator(".aos-cp-tab")).toHaveCount(1);
    await expect(pane(win, "chat").locator(".aos-cp-url")).toHaveValue(shopUrl());
    expect((await externalOf(h.app)).length).toBe(before);
    await link.click();
    await expect(pane(win, "chat").locator(".aos-cp-tab")).toHaveCount(2);
    expect((await externalOf(h.app)).length).toBe(before);
    expectNoErrors(h);
  });

  // The other plan test (https goes to the default browser once, http shows the notice, outside a session) is not written: History lists
  // digests of past sessions, and Vault chat's log is filled only by its agent, whose stand-in reply is the fixed text "Done with the
  // computer." (harness.ts agentScript finish), so neither can be made to show a link without more harness work.

  test("the pop-out follows the selected session and stays open, empty, while its browser is off", async () => {
    const h = app();
    const { win, app: electron } = h;
    const termId = () => win.evaluate(() => (window as unknown as { aosHost: { plugin: { terminalPool: { selectedId(): string | null } } } }).aosHost.plugin.terminalPool.selectedId());
    const a = await codeAgent(h, "claude");
    const keyA = (await selectedOf(h)) as string;
    const termA = await termId();
    const b = await codeAgent(h, "codex", { surfaceOff: true });
    const termB = await termId();
    try {
      expectReply(await a.call("computer_open", { url: shopUrl() }), { isError: false });
      await content(win).locator(`.aos-tl-row[data-session="${termA}"]`).click();
      await expect.poll(() => selectedOf(h)).toBe(keyA);
      const p = pane(win, "code");
      await p.locator(".aos-cp-popout").click();
      await expect(p).toHaveClass(/is-popped/);
      await expect.poll(async () => (await browserTitles(electron)).length, { message: "one pop-out window" }).toBe(1);
      const titleA = (await browserTitles(electron))[0];
      expect(titleA).toMatch(/^UniDeX Browser: .+/);
      expect(titleA).not.toMatch(/\(off\)$/);
      await content(win).locator(`.aos-tl-row[data-session="${termB}"]`).click();
      await expect.poll(async () => (await browserTitles(electron)).join("|"), { message: "the window follows to B, whose browser is off" }).toMatch(/ \(off\)$/);
      // Empty: B's browser has no view in the window (main's seam names the selected session's page, null for an off browser).
      expect(await pageOf(h, (await selectedOf(h)) as string), "the off session has no view").toBeNull();
      expect(await browserTitles(electron)).toHaveLength(1);
      await content(win).locator(`.aos-tl-row[data-session="${termA}"]`).click();
      await expect.poll(async () => (await browserTitles(electron)).join("|"), { message: "the window is A's again" }).toBe(titleA);
      await electron.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && w.getTitle().startsWith("UniDeX Browser")) w.close(); });
      await expect(p).not.toHaveClass(/is-popped/);
    } finally { await a.finish(); await b.finish(); }
    expectNoErrors(h);
  });

  test("a Turn on request raised while the user is on another tab notifies", async () => {
    const h = app();
    const { win, app: electron } = h;
    const a = await codeAgent(h, "claude", { surfaceOff: true });
    try {
      await openTab(win, "pulse");
      const before = (await notices(electron)).length;
      const held = a.call("computer_open", { url: shopUrl() });
      held.catch(() => undefined);
      await expect.poll(async () => (await notices(electron)).length, { message: "a desktop notice was raised" }).toBeGreaterThan(before);
      // The Turn on ask's own notice (service.ts: card.notice "turn the browser on", shown as the title by notify.ts noticeTitle).
      const raised = (await notices(electron)).slice(before);
      expect(raised.map((n) => n.title)).toEqual(["turn the browser on"]);
      expect(raised[0].body).toContain("is waiting for your answer in the Computer pane");
      await openTab(win, "term");
      const p = pane(win, "code");
      await expect(cards(p)).toHaveCount(1);
      await cards(p).locator('[data-answer="deny"]').click();
      expectReply(await held, { isError: true, text: /The user declined to turn the browser on/ });
    } finally { await a.finish(); }
    expectNoErrors(h);
  });
});

// ── a relaunch ───────────────────────────────────────────────────────

// Not useApp: this one launches the app twice, with no fixture reset between, as quit.spec.ts launches and quits its app.
test.describe("session browser: a relaunch (session-browser S6, S7)", () => {
  const env: Record<string, string | undefined> = { AOS_APP_WRITE: "computer,sessions", ...computerEnv() };
  test.beforeAll(async () => { site = await startSite(); env.AOS_E2E_START_PAGE = startUrl(); });
  test.afterAll(async () => { await site?.close(); });
  let live: AppHandle | null = null;
  test.afterEach(async () => { await live?.close(); live = null; });
  const options = () => ({ env, prepare: () => { prepare({ claude: true, codex: true }); markSite(`http://marked.test:${site.port}`); } });
  const selectedOf = (h: AppHandle) => h.app.evaluate(() => (globalThis as unknown as { __aosMain: { computerSelected(): string | null } }).__aosMain.computerSelected());
  const pageOf = (h: AppHandle, key: string) => h.app.evaluate((_e, k) => (globalThis as unknown as { __aosMain: { computerPageId(s?: string): number | null } }).__aosMain.computerPageId(k), key);
  const tabLines = (r: { text: string }) => r.text.split("\n").filter((l) => /^ {2}\[\d+\]/.test(l)).join("\n");

  test("a thread's browser that was on at quit is back, asleep with its tabs, after a relaunch, and the launch itself does not crash (B1)", async () => {
    test.setTimeout(240_000);
    restoreFixture();
    live = await launchApp(options());
    const a = await chatAgent(live, { text: "computer: relaunch keeps the browser" });
    const key = (await selectedOf(live)) as string;
    expect(key).toMatch(/^chat:/);
    let count: number;
    try {
      expectReply(await a.call("computer_open", { url: shopUrl() }), { isError: false });
      await expect.poll(async () => tabLines(await a.call("computer_status")), { message: "the shop is open" }).toContain(shopHost());
      count = tabLines(await a.call("computer_status")).split("\n").length;
      await expect(pane(live.win, "chat").locator(".aos-cp-tab")).toHaveCount(count);
    } finally { await a.finish().catch(() => undefined); }
    // A real quit: main flushes the browser records on the way out (close() waits for everything the app started).
    await live.close();
    live = null;
    // The record file (BrowserRecords: { schema: 1, browsers: { <key>: { on, tabs, active, at } } }) names the thread, on, with the page.
    const file = path.join(USER_DATA, "computer", "browsers.json");
    expect(fs.existsSync(file), "the quit wrote the record file").toBe(true);
    const rec = (JSON.parse(fs.readFileSync(file, "utf8")) as { browsers: Record<string, { on: boolean; tabs: string[] }> }).browsers[key];
    expect(rec?.on, "the thread's record says the browser was on").toBe(true);
    expect(rec?.tabs.some((t) => t.startsWith(shopUrl())), `the record holds the shop's address: ${JSON.stringify(rec?.tabs)}`).toBe(true);
    // The second launch, with the fixture as the first left it: before the fix main died at startup on this record, so
    // launchApp throwing is the failure.
    live = await launchApp(options());
    const h = live;
    expect(h.errors.filter((e) => /computer|browser/i.test(e)), "nothing about the computer or a browser went wrong at startup").toEqual([]);
    // Asleep: main restored the record but made no page for it, until the thread is selected.
    expect(await pageOf(h, key), "asleep: the thread's browser has no page before it is selected").toBeNull();
    await openTab(h.win, "chat");
    await content(h.win).locator(`.aos-ss-row[data-thread="${key.slice("chat:".length)}"]`).click();
    await expect.poll(() => selectedOf(h), { message: "the pane followed to the thread" }).toBe(key);
    await expect(pane(h.win, "chat").locator(".aos-cp-tab")).toHaveCount(count);
    await expect(pane(h.win, "chat").locator('button.aos-cp-power[role="switch"]')).toHaveText("On");
    await expect(pane(h.win, "chat").locator(".aos-cp-url")).toHaveValue(shopUrl());
    await expect.poll(() => pageOf(h, key), { message: "selecting the thread woke its browser" }).not.toBeNull();
    expectNoErrors(h);
  });
});

// ── the Computer surface off (the default) ───────────────────────────

test.describe("the Computer surface off (a run whose AOS_APP_WRITE leaves it out)", () => {
  const app = useApp({ env: { AOS_APP_WRITE: "sessions", ...computerEnv() }, prepare: () => prepare({ claude: true, codex: false }) });

  test("the pane is only its collapsed strip on Code and Sessions, whatever they show (R54)", async () => {
    const h = app();
    const { win } = h;
    const strip = async (page: "code" | "chat") => {
      const p = pane(win, page);
      await expect(p).toHaveClass(/is-collapsed/);
      await expect(p).toHaveClass(/is-off/);
      await expect(p).toHaveAttribute("aria-label", "The Computer pane is off.");
      await expect(p.locator(".aos-cp-collapse")).toBeDisabled();
      expect((await p.boundingBox())!.width).toBeLessThanOrEqual(41);
    };
    await openTab(win, "term");
    await strip("code");
    expect(await command(win, "agentic-os:new-terminal-shell")).toBe(true);
    await expect(content(win).locator(".aos-tl-row.aos-term-tab-active")).toHaveCount(1);
    await strip("code");
    await openTab(win, "chat");
    await strip("chat");
    expectNoErrors(h);
  });

  test("an agent's computer tools say the pane is off in UniDeX, not that the app is missing (D26)", async () => {
    const h = app();
    const a = await chatAgent(h, { text: "computer: surface off", surfaceOff: true });
    try {
      const r = await a.call("computer_status");
      expectReply(r, { isError: true, text: "The UniDeX browser is turned off in Settings for this run of the app: use another browser tool, or ask the user to turn the Computer pane on and restart UniDeX." });
    } finally { await a.finish(); }
    expectNoErrors(h);
  });
});

// ── a Codex-only machine, the Computer surface on ────────────────────

test.describe("a Codex-only machine, the Computer surface on", () => {
  test.beforeAll(async () => { site = await startSite(); });
  test.afterAll(async () => { await site?.close(); });
  const app = useApp({ env: { AOS_APP_WRITE: "computer,sessions", ...computerEnv() }, prepare: () => prepare({ claude: false, codex: true }) });

  test("a Codex turn's ask shows its card in the pane and badges Sessions, as on Claude Code (D27, D33)", async () => {
    const h = app();
    const { win } = h;
    const a = await chatAgent(h, { host: "codex", text: "computer: codex only" });
    try {
      await a.call("computer_open", { url: shopUrl() });
      const add = refOf((await a.call("computer_snapshot")).text, "button", "Add to basket");
      const p = pane(win, "chat");
      const title = `Act on a site you haven't marked: Click “Add to basket” on ${shopHost()}?`;
      const held = await asked(p, a.call("computer_click", { ref: add }), title);
      await expect(badge(win, "chat")).toHaveText("1");
      await held.card.locator('[data-answer="once"]').click();
      expectReply(await held.reply, { isError: false, text: acted(`Clicked ${add}.`, shopUrl()) });
      await expect(badge(win, "chat")).toHaveText("");
    } finally { await a.finish(); }
    // Electron itself writes a warning when a page's load fails: here the start page a manual On opens, which nothing
    // serves in this describe. Main handles the rejection (a log line in the pane); only that warning is allowed.
    expect(h.errors.filter((e) => !/electron: Failed to load URL: http:\/\/127\.0\.0\.1\/ with error: ERR_CONNECTION_REFUSED/.test(e)), "renderer/main errors").toEqual([]);
  });
});

// ── a page a program opens, and the way out (session-browser S23, S24) ───────

test.describe("session browser: pages a program opens, and Open in my browser (session-browser S23, S24)", () => {
  // The app runs with BROWSER set to a stand-in that only appends its argument to a file in this spec's own temp folder: the
  // opener's "previous BROWSER" is then the stand-in, so a page that fell back (the door unreachable, a refused message) lands
  // in the file and never in the Mac's default browser. Every test asserts the file stayed empty and that main's own external
  // opens (`__aosMain.externalOpens`, the harness's recorded shell.openExternal) gained nothing but what the test expects.
  // Made in beforeAll, so a worker that never runs this describe leaves no folder behind.
  let rec = "", recorder = "", recorded = "";
  const fell = (): string[] => (fs.existsSync(recorded) ? fs.readFileSync(recorded, "utf8").split("\n").filter(Boolean) : []);
  const env: Record<string, string | undefined> = { AOS_APP_WRITE: "computer,sessions", ...computerEnv() };
  test.beforeAll(async () => {
    site = await startSite();
    env.AOS_E2E_START_PAGE = startUrl();
    rec = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "aos-bro-"));
    recorder = path.join(rec, "browser.sh");
    recorded = path.join(rec, "opened.txt");
    fs.writeFileSync(recorder, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${recorded}'\n`, { mode: 0o755 });
    env.BROWSER = recorder;
  });
  test.afterAll(async () => { await site?.close(); if (rec) fs.rmSync(rec, { recursive: true, force: true }); });
  const app = useApp({ env, prepare: () => { prepare({ claude: true, codex: true }); } });
  const OPEN_PAGE = path.join(__dirname, "fixtures", "computer", "open-page.js");
  /** A page of the fixture site under its own host, so no two opens share an address. */
  const pageUrl = (n: string | number): string => `http://prog${n}.test:${site.port}/landed.html`;
  const selectedOf = (h: { app: ElectronApplication }) => h.app.evaluate(() => (globalThis as unknown as { __aosMain: { computerSelected(): string | null } }).__aosMain.computerSelected());
  const externalOf = (h: { app: ElectronApplication }) =>
    h.app.evaluate(() => (globalThis as unknown as { __aosMain: { externalOpens(): Array<{ url: string; opened: boolean }> } }).__aosMain.externalOpens());
  /** What the session's environment says (AOS_BROWSER_SESSION: the id, the door's socket and the BROWSER set before). */
  async function sessionVar(a: Agent): Promise<{ id: string; door: string; prev: string | null }> {
    const r = await a.exec(AGENT.node, ["-e", "process.stdout.write(process.env.AOS_BROWSER_SESSION || '')"]);
    expect(r.out, "the session carries the opener's variable").not.toBe("");
    return JSON.parse(Buffer.from(r.out, "base64url").toString("utf8")) as { id: string; door: string; prev: string | null };
  }
  /** One message to the door, as a program with no opener would send it; its answer. */
  const knock = (door: string, line: string): Promise<string> => new Promise((resolve, reject) => {
    const sock = net.createConnection(door);
    let got = "";
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(`${line}\n`));
    sock.on("data", (d: string) => { got += d; });
    sock.on("close", () => resolve(got));
    sock.on("error", reject);
    setTimeout(() => { sock.destroy(); resolve(got); }, 5000).unref();
  });
  /** Waits for the Turn on card a program's open raised, checks its words and answers Turn on. */
  async function turnOn(p: Locator, url: string): Promise<void> {
    await expect(cards(p)).toHaveCount(1);
    await expect(cards(p).locator(".aos-cp-asktitle")).toContainText(`wants to turn its browser on and open ${new URL(url).host}`);
    await expect(cards(p).locator('[data-answer="once"]')).toHaveText("Turn on");
    await expect(cards(p).locator('[data-answer="deny"]')).toHaveText("Not now");
    await cards(p).locator('[data-answer="once"]').click();
    await expect(cards(p)).toHaveCount(0);
  }
  const titleOf = (h: { app: ElectronApplication }, url: string, session: string) => inPage<string>(h.app, url, "document.title", session);

  test("a page a program opens shows in that session's browser after Turn on, and nothing reaches the default browser", async () => {
    const h = app();
    const { win } = h;
    const externalBefore = (await externalOf(h)).length;
    // 1. A Code agent's command: its environment is the session's. It goes first because it asserts that the opener's fallback
    // is the recording stand-in (every session's `prev` comes from the app's one environment), before any page is opened.
    const code = await codeAgent(h, "claude", { surfaceOff: true });
    let codeKey = "";
    try {
      const v = await sessionVar(code);
      expect(v.prev, "the stand-in is the BROWSER the opener falls back to").toBe(recorder);
      const codePage = pageUrl(2);
      expect((await code.exec(AGENT.node, [OPEN_PAGE, codePage])).status).toBe(0);
      await turnOn(pane(win, "code"), codePage);
      codeKey = (await selectedOf(h)) as string;
      expect(codeKey).toMatch(/^code:t\d+$/);
      expect(await titleOf(h, codePage, codeKey)).toBe("Harbour landed");
    } finally { await code.finish(); }

    // 2. A shell terminal, no agent in it: the person's own program. The command is typed into the terminal.
    expect(await command(win, "agentic-os:new-terminal-shell")).toBe(true);
    await expect(rail(win, "term")).toHaveClass(/is-active/);
    // The agent's terminal is still the selected one until the pane follows the new shell: wait for a key that is not its own.
    await expect.poll(async () => { const k = await selectedOf(h); return k !== null && k !== codeKey && /^code:t\d+$/.test(k); }, { message: "the pane followed to the NEW shell" }).toBe(true);
    const shellKey = (await selectedOf(h)) as string;
    const shellPage = pageUrl(1);
    await win.evaluate((cmd) => {
      const pool = (window as unknown as { aosHost: { plugin: { terminalPool: { selectedId(): string | null; get(id: string): { write(d: string): void } | undefined } } } }).aosHost.plugin.terminalPool;
      pool.get(pool.selectedId() ?? "")?.write(cmd);
    }, `'${AGENT.node}' '${OPEN_PAGE}' '${shellPage}'\r`);
    await turnOn(pane(win, "code"), shellPage);
    expect(await titleOf(h, shellPage, shellKey)).toBe("Harbour landed");
    await expect(pane(win, "code").locator(".aos-cp-tab")).toHaveCount(1);


    // 3. A Chat turn's command, in the thread's browser.
    const chat = await chatAgent(h, { text: "computer: a program opens a page", surfaceOff: true });
    try {
      const chatPage = pageUrl(3);
      expect((await sessionVar(chat)).prev, "the stand-in is the BROWSER the opener falls back to").toBe(recorder);
      expect((await chat.exec(AGENT.node, [OPEN_PAGE, chatPage])).status).toBe(0);
      await turnOn(pane(win, "chat"), chatPage);
      const chatKey = (await selectedOf(h)) as string;
      expect(chatKey).toMatch(/^chat:/);
      expect(await titleOf(h, chatPage, chatKey)).toBe("Harbour landed");
    } finally { await chat.finish(); }

    // The shell's page is still in the shell's browser, and no program reached the default browser.
    expect(await titleOf(h, shellPage, shellKey)).toBe("Harbour landed");
    expect(fell(), "the BROWSER stand-in recorded nothing").toEqual([]);
    expect((await externalOf(h)).length, "main opened nothing outside").toBe(externalBefore);
    expect((await h.opened()).filter((o) => o.fn === "openExternal")).toEqual([]);
    expectNoErrors(h);
  });

  test("a seventh open within a minute is dropped; a message without a live id opens nothing", async () => {
    const h = app();
    const { win } = h;
    const externalBefore = (await externalOf(h)).length;
    const a = await codeAgent(h, "claude");
    try {
      const v = await sessionVar(a);
      expect(v.prev, "the stand-in is the BROWSER the opener falls back to").toBe(recorder);
      const p = pane(win, "code");
      // The browser was turned on by hand (the start page is its one tab): a program's pages add to it without a card.
      await expect(p.locator(".aos-cp-tab")).toHaveCount(1);
      for (let n = 10; n < 16; n++) expect((await a.exec(AGENT.node, [OPEN_PAGE, pageUrl(n)])).status, `open ${n}`).toBe(0);
      await expect(p.locator(".aos-cp-tab")).toHaveCount(7);
      await expect(cards(p)).toHaveCount(0);
      // The seventh in the minute: the door refuses it, the opener still exits 0, and no tab is made.
      expect((await a.exec(AGENT.node, [OPEN_PAGE, pageUrl(16)])).status).toBe(0);
      await new Promise((r) => setTimeout(r, 750));
      await expect(p.locator(".aos-cp-tab")).toHaveCount(7);
      // A message that names no live session opens nothing, and gets no ok.
      const answer = await knock(v.door, JSON.stringify({ id: "0".repeat(32), url: pageUrl(17) }));
      expect(answer).not.toContain('"ok":true');
      await new Promise((r) => setTimeout(r, 750));
      await expect(p.locator(".aos-cp-tab")).toHaveCount(7);
    } finally { await a.finish(); }
    expect(fell(), "the BROWSER stand-in recorded nothing").toEqual([]);
    expect((await externalOf(h)).length, "main opened nothing outside").toBe(externalBefore);
    expectNoErrors(h);
  });

  test("after Take over a program's page opens behind the tab the person is on", async () => {
    const h = app();
    const { win } = h;
    const externalBefore = (await externalOf(h)).length;
    const a = await codeAgent(h, "claude");
    let p: Locator | null = null;
    try {
      p = pane(win, "code");
      const key = (await selectedOf(h)) as string;
      expect((await sessionVar(a)).prev, "the stand-in is the BROWSER the opener falls back to").toBe(recorder);
      // The browser was turned on by hand: the start page is its one tab, and the person is on it.
      await expect(p.locator(".aos-cp-tab")).toHaveCount(1);
      // The pane names a tab on the start page "New tab" (the page's own title is "Start", read below through the browser).
      await expect(p.locator(".aos-cp-tab.is-active .aos-cp-tabtitle")).toHaveText("New tab");
      expect(await titleOf(h, startUrl(), key)).toBe("Start");
      await p.locator(".aos-cp-drivebtn", { hasText: "Take over" }).click();
      await expect(p.locator(".aos-cp-drive")).toHaveClass(/is-user/);
      // The agent's program opens a page while the person holds the wheel.
      const behind = pageUrl(20);
      expect((await a.exec(AGENT.node, [OPEN_PAGE, behind])).status).toBe(0);
      await expect(p.locator(".aos-cp-tab")).toHaveCount(2);
      // The person's tab stays in front: the strip's marker and the browser's own active page are unchanged.
      await expect(p.locator(".aos-cp-tab.is-active")).toHaveCount(1);
      await expect(p.locator(".aos-cp-tab.is-active .aos-cp-tabtitle")).toHaveText("New tab");
      expect(await titleOf(h, startUrl(), key), "the active page is still the start page").toBe("Start");
      // The new page really loaded in its tab behind: read it through the tab's own web contents, which the active-tab helper cannot reach.
      await expect.poll(() => h.app.evaluate(async ({ webContents }, u) => {
        const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith(u));
        return wc ? (wc.executeJavaScript("document.title") as Promise<string>) : null;
      }, behind), { message: "the background tab loaded the program's page" }).toBe("Harbour landed");
      await expect(cards(p)).toHaveCount(0);
      expect(fell(), "the BROWSER stand-in recorded nothing").toEqual([]);
      expect((await externalOf(h)).length, "main opened nothing outside").toBe(externalBefore);
    } finally {
      // Hand back, so the next test starts clean.
      if (p) await p.locator(".aos-cp-drivebtn", { hasText: "Hand back" }).click({ timeout: 2000 }).catch(() => undefined);
      await a.finish();
    }
    expect((await h.opened()).filter((o) => o.fn === "openExternal")).toEqual([]);
    expectNoErrors(h);
  });

  test("Open in my browser waits for an https page, sends it out keeping the tab, and refuses an http page", async () => {
    const h = app();
    const { win } = h;
    const externalBefore = (await externalOf(h)).length;
    const a = await codeAgent(h, "claude");
    try {
      const p = pane(win, "code");
      const outside = p.locator("button.aos-cp-icon.aos-cp-outside");
      await expect(outside).toHaveAttribute("aria-label", "Open in my browser");
      // The start page is http (the fixture site): the button waits, and main refuses the page's own call as well.
      await expect(outside).toBeDisabled();
      // The button also waits while the start page is still loading, and main then has no page to refuse ("No page is
      // open."): the call below is about the http page, so it goes once the tab is on it.
      await inPage(h.app, startUrl(), "1");
      const call = () => win.evaluate(() => (window as unknown as { aos: { computer: { openOutside(): Promise<unknown> } } }).aos.computer.openOutside());
      expect(await call()).toEqual({ ok: false, error: "Only https pages open in your browser.", code: "EROFS" });
      // main decided on its own: the refused page never reached the external-open path, so nothing is recorded or logged.
      expect((await externalOf(h)).slice(externalBefore), "a refused page records no external open").toEqual([]);
      await expect(p.locator(".aos-cp-tab")).toHaveCount(1);
      // An https page (the fixture site speaks only http, so its load fails, but the tab keeps the address): the button wakes,
      // the page goes to main's one external-open path (recorded, not opened), and the tab stays.
      const secure = `https://shop.test:${site.port}/shop.html`;
      await win.evaluate((u) => (window as unknown as { aos: { computer: { navigate(u: string): Promise<unknown> } } }).aos.computer.navigate(u), secure);
      await expect(outside).toBeEnabled();
      await outside.click();
      await expect.poll(async () => (await externalOf(h)).slice(externalBefore).at(-1), { message: "the https page went out" }).toEqual({ url: secure, opened: true });
      expect((await h.opened()).filter((o) => o.fn === "openExternal").at(-1)?.arg).toBe(secure);
      await expect(p.locator(".aos-cp-tab")).toHaveCount(1);
      await expect(outside).toBeEnabled();
    } finally { await a.finish(); }
    expect(fell(), "the BROWSER stand-in recorded nothing").toEqual([]);
    // Electron writes a warning to stderr whenever a page's load fails: here the https address the plain-http fixture server
    // cannot serve, and only that one (as the redirect test above expects its own).
    const warning = `electron: Failed to load URL: https://shop.test:${site.port}/shop.html with error: ERR_SSL_PROTOCOL_ERROR`;
    await expect.poll(() => h.errors.some((e) => e.includes(warning)), { message: "the one load warning" }).toBe(true);
    const late = h.errors.splice(0).filter((e) => !e.includes(warning));
    expect(late, "renderer/main errors").toEqual([]);
    expectNoErrors(h);
  });
});

// ── the Computer setting off: a program's page goes where it went before (session-browser S23) ─────

test.describe("session browser: with the Computer setting off a program's page goes where it went before (session-browser S23)", () => {
  // The vault's config says computer.enabled is false, so main adds no variables to a new session and the program's BROWSER is
  // the app's own: the recording stand-in (never the Mac's default browser). The test asserts the recorder holds exactly the
  // one address and that main opened nothing outside.
  let rec = "", recorded = "";
  const fell = (): string[] => (fs.existsSync(recorded) ? fs.readFileSync(recorded, "utf8").split("\n").filter(Boolean) : []);
  const env: Record<string, string | undefined> = { AOS_APP_WRITE: "computer,sessions", ...computerEnv() };
  test.beforeAll(async () => {
    site = await startSite();
    rec = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "aos-bro-"));
    const recorder = path.join(rec, "browser.sh");
    recorded = path.join(rec, "opened.txt");
    fs.writeFileSync(recorder, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${recorded}'\n`, { mode: 0o755 });
    env.BROWSER = recorder;
  });
  test.afterAll(async () => { await site?.close(); if (rec) fs.rmSync(rec, { recursive: true, force: true }); });
  const app = useApp({
    env,
    prepare: () => {
      prepare({ claude: true, codex: true });
      editJson(path.join(FX.claude, "agenticos.json"), (j) => { j.computer = { ...(j.computer ?? {}), enabled: false }; });
    },
  });
  const OPEN_PAGE = path.join(__dirname, "fixtures", "computer", "open-page.js");
  const externalOf = (h: { app: ElectronApplication }) =>
    h.app.evaluate(() => (globalThis as unknown as { __aosMain: { externalOpens(): Array<{ url: string; opened: boolean }> } }).__aosMain.externalOpens());

  test("a shell's program opens its page in the recording stand-in: no card, no tab, nothing opened by main", async () => {
    const h = app();
    const { win } = h;
    const externalBefore = (await externalOf(h)).length;
    expect(await command(win, "agentic-os:new-terminal-shell")).toBe(true);
    await expect(rail(win, "term")).toHaveClass(/is-active/);
    const page = `http://prog30.test:${site.port}/landed.html`;
    await win.evaluate((cmd) => {
      const pool = (window as unknown as { aosHost: { plugin: { terminalPool: { selectedId(): string | null; get(id: string): { write(d: string): void } | undefined } } } }).aosHost.plugin.terminalPool;
      pool.get(pool.selectedId() ?? "")?.write(cmd);
    }, `'${AGENT.node}' '${OPEN_PAGE}' '${page}'\r`);
    await expect.poll(() => fell(), { message: "the stand-in got the program's address" }).toEqual([page]);
    // Nothing else follows: no second copy, no card, no tab made.
    await new Promise((r) => setTimeout(r, 750));
    expect(fell(), "exactly the one address").toEqual([page]);
    const p = pane(win, "code");
    await expect(cards(p)).toHaveCount(0);
    await expect(p.locator(".aos-cp-tab")).toHaveCount(0);
    expect((await externalOf(h)).length, "main opened nothing outside").toBe(externalBefore);
    expect((await h.opened()).filter((o) => o.fn === "openExternal")).toEqual([]);
    expectNoErrors(h);
  });
});
