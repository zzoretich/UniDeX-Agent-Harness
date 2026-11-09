// The Computer pane, release 1: the Browser (spec 2026-11-06-agent-computer §6; D9, D17, D18, D26, D27, D31, D32, D35,
// D39, D43, §4.2), end to end. The agents are stand-ins (harness.ts AGENT): the app spawns them as it spawns Claude Code
// and Codex, for a Chat turn and as a Code launch's terminal process, so the bridge admits them by spawn ownership; each
// starts the plugin launcher's MCP server and calls the computer_* tools when a test asks. The sites are the fixture
// pages in fixtures/computer, served on 127.0.0.1 and reached as *.test hosts (the test switch AOS_E2E_HOST_RULES):
// shop.test is unmarked, marked.test is marked before launch. The `computer` surface is on by default since its live
// checks (verified: true); these files name it in AOS_APP_WRITE, but for the one that runs with it left out.

import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import {
  FX, RC_ONLY, TOUR_BOOK, USER_DATA, addRcOnly, agentRun, badge, command, computerEnv, content, expectNoErrors, installComputerAgents, openTab,
  USER_DATA_LINK, providerState, rail, startOutsider, useApp, type Agent, type AgentReply,
} from "./harness";

// ── the fixture sites ────────────────────────────────────────────────

interface Seen { method: string; url: string; body: string }
interface Site { port: number; seen: Seen[]; close(): Promise<void> }

/** Serves fixtures/computer/<name>.html at /<name>.html for any host, plus a same-origin POST, a redirect to a data: URL,
 *  a download and a form's GET; every request is recorded. */
async function startSite(): Promise<Site> {
  const dir = path.join(__dirname, "fixtures", "computer");
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (d: string) => { body += d; });
    req.on("end", () => {
      const url = req.url ?? "/";
      seen.push({ method: req.method ?? "GET", url, body });
      const page = /^\/([a-z]+)\.html$/.exec(url)?.[1];
      if (page && fs.existsSync(path.join(dir, `${page}.html`))) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(fs.readFileSync(path.join(dir, `${page}.html`)));
      } else if (url === "/continue" && req.method === "POST") {
        res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      } else if (url === "/to-data") {
        res.writeHead(302, { location: "data:text/html,<p>Landed on a data page</p>" }).end();
      } else if (url === "/download/tides.csv") {
        res.writeHead(200, { "content-type": "text/csv", "content-disposition": 'attachment; filename="tides.csv"' }).end("time,height\n06:00,1.2\n");
      } else if (url.startsWith("/note?")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><title>Noted</title><p>Noted</p>");
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

/** A Chat turn's agent: a new session in harbor-map whose prompt names it. */
async function chatAgent(win: Page, o: { host?: Host; text: string; access?: Access }): Promise<Agent> {
  const after = Date.now();
  const host = o.host ?? "claude";
  await newSession(win, { workspace: WS, host, text: o.text, access: o.access ?? "edit" });
  return agentRun((r) => r.mode === "chat" && r.host === host && r.prompt === o.text, after);
}

/** A Code launch's agent: ⌥⌘1 or ⌥⌘2, which starts the host in the vault as the terminal's own process. */
async function codeAgent(win: Page, host: Host): Promise<Agent> {
  const after = Date.now();
  expect(await command(win, `agentic-os:new-terminal-${host}`)).toBe(true);
  await expect(rail(win, "term")).toHaveClass(/is-active/);
  return agentRun((r) => r.mode === "code" && r.host === host, after);
}

/** Starts `call` and waits for its ask's card in `p`; returns the card and the call, still held. */
async function asked(p: Locator, call: Promise<AgentReply>, title: string | RegExp): Promise<{ card: Locator; reply: Promise<AgentReply> }> {
  const card = cards(p).filter({ has: p.page().locator(".aos-cp-asktitle", { hasText: title }) });
  await expect(card).toHaveCount(1);
  await expect(card.locator(".aos-cp-asktitle")).toHaveText(title);
  return { card, reply: call };
}

/** Runs JavaScript in the computer's page whose address starts with `url` (the spec's own look; the agent cannot). */
async function inPage<T>(app: ElectronApplication, url: string, js: string): Promise<T> {
  return app.evaluate(async ({ webContents }, o) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith(o.url));
    if (!wc) throw new Error(`no page at ${o.url}`);
    return wc.executeJavaScript(o.js) as Promise<T>;
  }, { url, js });
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
  test.beforeAll(async () => { site = await startSite(); });
  test.afterAll(async () => { await site?.close(); });
  const app = useApp({
    env: { AOS_APP_WRITE: "computer,sessions", ...computerEnv() },
    prepare: () => { prepare({ claude: true, codex: true }); markSite(`http://marked.test:${site.port}`); },
  });

  test("a Chat turn opens a page in the pane, snapshots it and clicks; the pane shows its tab, address and driver (§6, D19, D32)", async () => {
    const h = app();
    const { win } = h;
    const a = await chatAgent(win, { text: "computer: basic flow" });
    try {
      const status = await a.call("computer_status");
      expectReply(status, { isError: false });
      expect(status.text).toContain(`Computer: ws:${WS}`);
      expect(status.text).toContain("Access: this session can act");
      expectReply(await a.call("computer_open", { url: shopUrl() }), { isError: false, text: `Opened the page. Page: ${wrapped(shopUrl())}` });
      const p = pane(win, "chat");
      await expect(p.locator(".aos-cp-place")).toHaveText(WS);
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
      expectReply(await a.call("computer_click", { ref: add }), { isError: false, text: `Clicked ${add}. Page: ${wrapped(shopUrl())}` });
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
    const a = await codeAgent(win, "codex");
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
      expect((await a.call("computer_status")).text).toContain("Computer: vault");
      expectReply(await a.call("computer_open", { url: repoUrl() }), { isError: false });
      const p = pane(win, "code");
      await expect(p.locator(".aos-cp-place")).toHaveText("Vault");
      await expect(p.locator(".aos-cp-url")).toHaveValue(repoUrl());
      await expect(p.locator(".aos-cp-trust")).toHaveText(`Acts freely on ${markedHost()}`);
      const details = refOf((await a.call("computer_snapshot")).text, "button", "Show details");
      expectReply(await a.call("computer_click", { ref: details }), { isError: false, text: `Clicked ${details}. Page: ${wrapped(repoUrl())}` });
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

  test("an unmarked site: a click asks first; Deny leaves the page as it was and Allow once clicks (D39, D6)", async () => {
    const h = app();
    const { win } = h;
    const a = await chatAgent(win, { text: "computer: unmarked click" });
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
      expectReply(await first.reply, { isError: true, text: `The user denied: Act on a site you haven't marked: Click on ${shopHost()}.` });
      await expect(cards(p)).toHaveCount(0);
      expect((await a.call("computer_snapshot")).text).toContain("Basket: empty");
      const second = await asked(p, a.call("computer_click", { ref: add }), title);
      await second.card.locator('[data-answer="once"]').click();
      expectReply(await second.reply, { isError: false, text: `Clicked ${add}. Page: ${wrapped(shopUrl())}` });
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
    const a = await chatAgent(win, { text: "computer: continue posts" });
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
    const a = await chatAgent(win, { text: "computer: tab then space" });
    try {
      const p = pane(win, "chat");
      expectReply(await a.call("computer_open", { url: shopUrl() }), { isError: false });
      expectReply(await a.call("computer_scroll", { dy: 900 }), { isError: false, text: `Scrolled by (0, 900). Page: ${wrapped(shopUrl())}` });
      await expect.poll(() => inPage<number>(electron, shopUrl(), "window.scrollY")).toBeGreaterThan(0);
      expectReply(await a.call("computer_key", { key: "Tab" }), { isError: false, text: `Pressed Tab. Page: ${wrapped(shopUrl())}` });
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
    const a = await chatAgent(win, { text: "computer: type asks" });
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
      expectReply(await second.reply, { isError: false, text: `Typed 4 characters. Page: ${wrapped(shopUrl())}` });
      expect(await inPage<string>(electron, shopUrl(), 'document.getElementById("search").value')).toBe("rope");
    } finally { await a.finish(); }
    expectNoErrors(h);
  });

  test("a marked site: Merge pull request, Sign in, a download behind a plain label and Return in an ordinary field each ask (D39, D43)", async () => {
    const h = app();
    const { win } = h;
    const a = await codeAgent(win, "claude");
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
    const a = await chatAgent(win, { text: "computer: hidden delete" });
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
      expectReply(await space.reply, { isError: true, text: `The user denied: Delete: Press Space on ${markedHost()}.` });
      expect((await a.call("computer_snapshot")).text).not.toContain("Repository deleted");
    } finally { await a.finish(); }
    expectNoErrors(h);
  });

  test("two same-named buttons: focus moving from one to the other while the card waits makes Allow refuse as changed (R76)", async () => {
    const h = app();
    const { win, app: electron } = h;
    const a = await chatAgent(win, { text: "computer: same-named focus" });
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
    const a = await chatAgent(win, { text: "computer: scrolled ref" });
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
      expectReply(await ask.reply, { isError: true, text: `The user denied: Act on a site you haven't marked: Click on ${shopHost()}.` });
    } finally { await a.finish(); }
    expectNoErrors(h);
  });

  test("a scrolled page: an x, y click is judged on the control under that point of the view, so Merge asks though a plain block shows a scroll's height above it (D43)", async () => {
    const h = app();
    const { win, app: electron } = h;
    const a = await chatAgent(win, { text: "computer: scrolled point" });
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
    const { win } = h;
    const a = await chatAgent(win, { text: "computer: typing navigates" });
    const typing = `http://marked.test:${site.port}/typing.html`;
    try {
      expectReply(await a.call("computer_open", { url: typing }), { isError: false });
      const log = refOf((await a.call("computer_snapshot")).text, "textbox", "Log entry");
      const r = await a.call("computer_type", { ref: log, text: "a".repeat(450) });
      expectReply(r, { isError: true, text: /^Typing stopped part way because the page or tab changed: look again\. Page: / });
      await expect.poll(() => site.seen.some((x) => x.url === "/landed.html")).toBe(true);
      await expect.poll(async () => (await a.call("computer_snapshot")).text, { timeout: 10_000 }).toContain("Nothing typed here");
    } finally { await a.finish(); }
    expectNoErrors(h);
  });

  test("a page's request for the microphone or the location, which the app cannot grant, is denied without a card and says so in the thread (M10)", async () => {
    const h = app();
    const { win, app: electron } = h;
    const a = await chatAgent(win, { text: "computer: ungrantable permissions" });
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
    const { win } = h;
    const a = await chatAgent(win, { text: "computer: schemes" });
    try {
      expectReply(await a.call("computer_open", { url: "javascript:document.title='x'" }), { isError: true, text: "Only http and https pages open." });
      expectReply(await a.call("computer_open", { url: "data:text/html,<p>A data page</p>" }), { isError: true, text: "Only http and https pages open." });
      const errors = h.errors.length;
      const redirect = await a.call("computer_open", { url: `http://shop.test:${site.port}/to-data` });
      expectReply(redirect, { isError: true });
      expect(redirect.text).toMatch(/^The page redirected to a .+ URL, which is refused\.$/);
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
    const { win, app: electron } = h;
    const a = await chatAgent(win, { text: "computer: passwords" });
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
      expectReply(await a.call("computer_type", { text: "guess", ref: refOf(snap, "textbox", "Password") }), { isError: true, text: "Typing into a password field is refused (D9)." });
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
    const opener = await chatAgent(win, { text: "computer: opener" });
    try { expectReply(await opener.call("computer_open", { url: shopUrl() }), { isError: false }); } finally { await opener.finish(); }
    const a = await chatAgent(win, { text: "computer: read only", access: "read" });
    try {
      expect((await a.call("computer_status")).text).toContain("Access: read only: this session can look but not act (D17)");
      const snap = await a.call("computer_snapshot");
      expectReply(snap, { isError: false });
      expect((await a.call("computer_screenshot")).image).toBeTruthy();
      const refused = { isError: true, text: "Read only: this session can look but not act (D17)." };
      expectReply(await a.call("computer_click", { ref: refOf(snap.text, "button", "Add to basket") }), refused);
      expectReply(await a.call("computer_open", { url: shopUrl() }), refused);
      expectReply(await a.call("computer_type", { text: "rope" }), refused);
      await expect(cards(pane(win, "chat"))).toHaveCount(0);
    } finally { await a.finish(); }
    expectNoErrors(h);
  });

  test("a second session on the same computer gets busy while the first drives; its look calls still work, and it acts once the first ends (D31)", async () => {
    const h = app();
    const { win } = h;
    const first = await chatAgent(win, { host: "claude", text: "computer: first driver" });
    const second = await chatAgent(win, { host: "codex", text: "computer: second driver" });
    try {
      expectReply(await first.call("computer_open", { url: shopUrl() }), { isError: false });
      const busy = await second.call("computer_open", { url: repoUrl() });
      expectReply(busy, { isError: true });
      expect(busy.text).toMatch(/^busy: .+ is driving$/);
      expectReply(await second.call("computer_snapshot"), { isError: false });
      expect((await second.call("computer_status")).text).toMatch(/Driving: .+ \(look tools still work; acting is busy\)/);
      await first.finish();
      expectReply(await second.call("computer_open", { url: repoUrl() }), { isError: false });
    } finally { await first.finish(); await second.finish(); }
    expectNoErrors(h);
  });

  test("refs are each session's own: after the page inserts a control and another session snapshots, a click on the first session's ref hits what it saw (I2)", async () => {
    const h = app();
    const { win, app: electron } = h;
    const first = await chatAgent(win, { host: "claude", text: "computer: refs first" });
    const second = await chatAgent(win, { host: "codex", text: "computer: refs second" });
    // Its own address (a fragment), so the spec's look finds this tab and not another computer's on the same page.
    const url = `${repoUrl()}#i2`;
    try {
      expectReply(await first.call("computer_open", { url }), { isError: false });
      const details = refOf((await first.call("computer_snapshot")).text, "button", "Show details");
      // The page inserts a plain control just before it (no ask word, and marked.test acts freely), then the second
      // session looks: its numbering gives that new control the first session's ref.
      await inPage(electron, url, `(() => { const b = document.createElement("button"); b.type = "button"; b.textContent = "Wipe notes";
        b.addEventListener("click", () => { document.getElementById("shown").textContent = "Notes wiped"; });
        document.getElementById("details").before(b); return true; })()`);
      const wipe = refOf((await second.call("computer_snapshot")).text, "button", "Wipe notes");
      expect(wipe).toBe(details);
      expectReply(await first.call("computer_click", { ref: details }), { isError: false, text: `Clicked ${details}. Page: ${wrapped(url)}` });
      const after = (await first.call("computer_snapshot")).text;
      expect(after).toContain("Details shown");
      expect(after).not.toContain("Notes wiped");
    } finally { await first.finish(); await second.finish(); }
    expectNoErrors(h);
  });

  test("off screen: a Code session's ask badges Code, marks its row waiting, notifies, and the notification and the Notifications item each open the pane on it (D27, D32, D35)", async () => {
    const h = app();
    const { win, app: electron } = h;
    const a = await codeAgent(win, "claude");
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
        { title: notice, body: "Claude Code in Vault is waiting for your answer in the Computer pane. Open the pane to allow or deny it; with no answer in time it is denied." },
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
    const a = await chatAgent(win, { text: "computer: take over" });
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
      expectReply(first, { isError: true, text: `Cancelled because the user took over: Act on a site you haven't marked: Click on ${shopHost()}.` });
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

  test("a process the app did not start is refused at hello; so are a session's second connection and a server behind a shell (D18)", async () => {
    const h = app();
    const { win } = h;
    const outsider = await startOutsider("claude");
    try {
      expectReply(await outsider.agent.call("computer_status"), { isError: true, text: NOT_STARTED });
      expectReply(await outsider.agent.call("computer_open", { url: shopUrl() }), { isError: true, text: NOT_STARTED });
    } finally { outsider.kill(); }
    const a = await chatAgent(win, { text: "computer: outsiders" });
    try {
      expectReply(await a.call("computer_status"), { isError: false });
      expectReply(await a.call("computer_status", {}, "second"), { isError: true, text: "This session's computer connection is already open." });
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
      expect(r.filter((x) => x.status === "missing" || x.status === "unrouted"), `chapter ${id}`).toEqual([]);
    }
    expect(TOUR_BOOK.chapters.find((c) => c.id === "code")?.steps.find((s) => s.id === "computer")?.anchor).toBe('[data-tour="computer-view"]');
    expectNoErrors(h);
  });

  test("quitting with a computer open and the pane popped out ends the app at once (R46)", async () => {
    const h = app();
    const { win, app: electron } = h;
    const a = await chatAgent(win, { text: "computer: quit" });
    expectReply(await a.call("computer_open", { url: shopUrl() }), { isError: false });
    const p = pane(win, "chat");
    await p.locator(".aos-cp-popout").click();
    await expect(p).toHaveClass(/is-popped/);
    await expect.poll(() => electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.getTitle() === "UniDeX Computer").length)).toBe(1);
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
    const a = await chatAgent(h.win, { text: "computer: surface off" });
    try {
      const r = await a.call("computer_status");
      expectReply(r, { isError: true, text: "The Computer pane is turned off in this UniDeX run, so this session cannot use the computer tools." });
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
    const a = await chatAgent(win, { host: "codex", text: "computer: codex only" });
    try {
      await a.call("computer_open", { url: shopUrl() });
      const add = refOf((await a.call("computer_snapshot")).text, "button", "Add to basket");
      const p = pane(win, "chat");
      const title = `Act on a site you haven't marked: Click “Add to basket” on ${shopHost()}?`;
      const held = await asked(p, a.call("computer_click", { ref: add }), title);
      await expect(badge(win, "chat")).toHaveText("1");
      await held.card.locator('[data-answer="once"]').click();
      expectReply(await held.reply, { isError: false, text: `Clicked ${add}. Page: ${wrapped(shopUrl())}` });
      await expect(badge(win, "chat")).toHaveText("");
    } finally { await a.finish(); }
    expectNoErrors(h);
  });
});
