import { test } from "node:test";
import assert from "node:assert/strict";
import { AskNotifier, noticeTitle, testSwitches } from "../../src/main/computer/notify";
import type { Ask } from "../../src/main/computer/asks";

// agent-computer D27, D26: an ask raised while the pane does not show it gets a desktop notification and a Notifications
// item, and clicking the notification reveals the pane on it. The test-build switches (D18, D39) never reach a packaged app.

const ask = (id: string, more: Partial<Ask> = {}): Ask => ({
  id, at: 0, computer: "ws:alpha", session: "chat:a", sessionLabel: "Alpha", why: "unmarked",
  title: "Act on a site you haven't marked: Click “Next” on a.test?", notice: "Act on a site you haven't marked: Click on a.test?",
  detail: "The button “Next” on https://a.test/", site: "https://a.test", ...more,
});

function make(o: { visible?: (a: Ask) => boolean; post?: (t: string, b: string) => Promise<void> } = {}) {
  const desktops: Array<{ title: string; body: string; click: () => void; closed: boolean }> = [];
  const posts: Array<[string, string]> = [];
  const reveals: string[] = [];
  const logs: string[] = [];
  const n = new AskNotifier({
    visible: o.visible ?? (() => false),
    desktop: (title, body, click) => { const d = { title, body, click, closed: false }; desktops.push(d); return () => { d.closed = true; }; },
    post: o.post ?? (async (t, b) => { posts.push([t, b]); }),
    reveal: (id) => reveals.push(id),
    log: (m) => logs.push(m),
  });
  return { n, desktops, posts, reveals, logs };
}
const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

test("an ask off-screen raises a desktop notification and a Notifications item; clicking it reveals that ask", async () => {
  const h = make();
  h.n.added(ask("a1"));
  await flush();
  assert.equal(h.desktops.length, 1);
  // I1: the ask's app-written notice, never its card title, which quotes the page's name for the control.
  assert.equal(h.desktops[0].title, "Act on a site you haven't marked: Click on a.test?");
  assert.ok(!h.desktops[0].title.includes("Next"));
  assert.match(h.desktops[0].body, /^Alpha is waiting for your answer in the Computer pane/);
  assert.deepEqual(h.posts, [[h.desktops[0].title, h.desktops[0].body]], "the item carries the same app-written text");
  assert.ok(!h.posts[0][1].includes("https://a.test/"), "the ask's detail (page text) never goes into the vault");
  assert.deepEqual(h.reveals, []);
  h.desktops[0].click();
  assert.deepEqual(h.reveals, ["a1"]);
});

test("an ask the pane shows raises nothing", async () => {
  const shown = new Set(["ws:alpha"]);
  const h = make({ visible: (a) => shown.has(a.computer) });
  h.n.added(ask("a1"));
  h.n.added(ask("b1", { computer: "ws:beta" }));
  await flush();
  assert.equal(h.desktops.length, 1, "only the ask the pane does not show");
  assert.equal(h.posts.length, 1);
  h.desktops[0].click();
  assert.deepEqual(h.reveals, ["b1"]);
});

test("sync notices each new ask once and withdraws a settled ask's desktop notification", async () => {
  const h = make();
  h.n.sync([ask("a1")]);
  h.n.sync([ask("a1"), ask("a2", { session: "chat:b" })]);
  await flush();
  assert.equal(h.desktops.length, 2, "a1 once, then a2");
  assert.equal(h.posts.length, 2);
  h.n.sync([ask("a2", { session: "chat:b" })]);
  assert.deepEqual(h.desktops.map((d) => d.closed), [true, false], "a1 settled: its notification is withdrawn");
  h.n.sync([]);
  assert.deepEqual(h.desktops.map((d) => d.closed), [true, true]);
  h.n.sync([ask("a2", { session: "chat:b" })]);
  assert.equal(h.desktops.length, 2, "an id seen before never notices again");
});

test("M11: at most one unanswered notice per session: its later asks only reach the pane until that one settles", async () => {
  const h = make();
  h.n.sync([ask("a1")]);
  h.n.sync([ask("a1"), ask("a2"), ask("a3")]);
  h.n.added(ask("a4"));
  await flush();
  assert.equal(h.desktops.length, 1, "one desktop notification for the session");
  assert.equal(h.posts.length, 1, "and one Notifications item in the vault");
  // Another session's ask, and a page's own ask on another computer, are noticed on their own.
  h.n.sync([ask("a1"), ask("a2"), ask("a3"), ask("b1", { session: "chat:b" }), ask("p1", { session: "page", computer: "vault" })]);
  await flush();
  assert.equal(h.desktops.length, 3);
  // The first settles while a later one still waits off-screen: that one is noticed now, still one at a time.
  h.n.sync([ask("a2"), ask("a3")]);
  await flush();
  assert.equal(h.desktops.length, 4);
  assert.equal(h.desktops[3].title, "Act on a site you haven't marked: Click on a.test?");
  h.desktops[3].click();
  assert.deepEqual(h.reveals, ["a2"]);
  assert.equal(h.posts.length, 4);
});

test("an ask raised on screen is noticed once, when it goes off-screen while still pending (the window blurs or hides)", async () => {
  let shown = true;
  const h = make({ visible: () => shown });
  h.n.sync([ask("a1")]);
  h.n.sync([ask("a1")]);
  await flush();
  assert.equal(h.desktops.length, 0, "on screen: nothing");
  shown = false;
  h.n.sync([ask("a1")]);
  h.n.sync([ask("a1")]);
  await flush();
  assert.equal(h.desktops.length, 1, "off screen now: noticed once");
  assert.equal(h.posts.length, 1);
  shown = true;
  h.n.sync([]);
  shown = false;
  h.n.sync([]);
  assert.equal(h.desktops.length, 1, "an ask that settled before it went off-screen is never noticed");
});

test("a failed post is logged, never thrown, and the desktop notification still shows", async () => {
  const h = make({ post: async () => { throw new Error("notify: the vault is read-only"); } });
  assert.doesNotThrow(() => h.n.added(ask("a1")));
  await flush();
  assert.equal(h.desktops.length, 1);
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0], /the vault is read-only/);
  const sync = make({ post: () => { throw new Error("no vault is open"); } });
  assert.doesNotThrow(() => sync.n.added(ask("a1")));
  await flush();
  assert.match(sync.logs[0], /no vault is open/);
});

test("a desktop notification that throws is logged and the post still goes", async () => {
  const posts: string[] = [];
  const logs: string[] = [];
  const n = new AskNotifier({
    visible: () => false, desktop: () => { throw new Error("notifications are not supported"); },
    post: async (t) => { posts.push(t); }, reveal: () => {}, log: (m) => logs.push(m),
  });
  assert.doesNotThrow(() => n.added(ask("a1")));
  await flush();
  assert.equal(posts.length, 1);
  assert.match(logs[0], /not supported/);
});

test("noticeTitle: one line the runtime accepts, at most 160 characters, never starting with a dash", () => {
  assert.equal(noticeTitle("Submit: Click “Pay” on a.test?"), "Submit: Click “Pay” on a.test?");
  assert.equal(noticeTitle("a\nb\u202ec\t d"), "a b c d");
  const long = noticeTitle(`Submit: ${"x".repeat(400)}`);
  assert.equal(long.length, 160);
  assert.ok(long.endsWith("…"));
  const wide = noticeTitle(`Submit: ${"\u{1F600}".repeat(100)}`);
  assert.ok(wide.length <= 160, "measured in UTF-16 units, as notify.js measures it");
  assert.ok(!/[\ud800-\udbff]…$/.test(wide), "never clipped inside a character");
  assert.equal(noticeTitle("--json"), "json");
  assert.equal(noticeTitle("  \n "), "An agent is asking in the Computer pane");
});

test("testSwitches: a dev or e2e run reads the host rules and the trusted CLIs (absolute paths only)", () => {
  assert.deepEqual(testSwitches({ AOS_E2E_HOST_RULES: "MAP *.test 127.0.0.1", AOS_E2E_TRUSTED_CLI: "/tmp/e2e/claude, relative/codex,,/tmp/e2e/codex" }, false), {
    hostRules: "MAP *.test 127.0.0.1", trustedCli: ["/tmp/e2e/claude", "/tmp/e2e/codex"], startPage: null,
  });
  assert.deepEqual(testSwitches({}, false), { hostRules: null, trustedCli: [], startPage: null });
  assert.deepEqual(testSwitches({ AOS_E2E_HOST_RULES: "  " }, false), { hostRules: null, trustedCli: [], startPage: null });
  assert.deepEqual(testSwitches({ AOS_E2E_HOST_RULES: "MAP *.test 127.0.0.1\nMAP * 10.0.0.1" }, false).hostRules, null, "one line or nothing");
});

test("testSwitches: a dev or e2e run reads the start page, so the suite's new tabs and searches stay on its fixture (an http or https page, no query or fragment)", () => {
  const start = (v?: string): string | null => testSwitches(v === undefined ? {} : { AOS_E2E_START_PAGE: v }, false).startPage;
  assert.equal(start("http://search.test:4100/"), "http://search.test:4100/");
  assert.equal(start(" http://127.0.0.1 "), "http://127.0.0.1/", "trimmed, and normalised as the browser loads it");
  assert.equal(start("https://start.test/home"), "https://start.test/home");
  const bad = [undefined, "", "  ", "search.test", "/start", "file:///tmp/start.html", "about:blank", "javascript:alert(1)", "data:text/html,x",
    "http://search.test/?q=x", "http://search.test/?", "http://search.test/#top", "http://a.test/\nhttp://b.test/", "http://a.test/ b"];
  for (const v of bad) assert.equal(start(v), null, JSON.stringify(v));
});

test("testSwitches: a packaged build ignores all three", () => {
  assert.deepEqual(testSwitches({ AOS_E2E_HOST_RULES: "MAP *.test 127.0.0.1", AOS_E2E_TRUSTED_CLI: "/tmp/e2e/claude", AOS_E2E_START_PAGE: "http://search.test:4100/" }, true), { hostRules: null, trustedCli: [], startPage: null });
});
