import { test } from "node:test";
import assert from "node:assert/strict";
import { HTTP_NOTICE, LINK_FAILED, REFUSED_NOTICE, followLink, linkRoute, sessionForLink } from "./linkRoute";
import type { HostComputer } from "../host";

const web = (s: string) => new URL(s);

function fake(openLink?: (session: string, url: string) => Promise<unknown>) {
  const calls = { opened: [] as string[][], external: [] as string[], notices: [] as string[] };
  const computer = openLink
    ? ({ openLink: async (s: string, u: string) => { calls.opened.push([s, u]); return openLink(s, u); } } as unknown as HostComputer)
    : undefined;
  const host = {
    computer,
    openExternal: async (u: string) => { calls.external.push(u); },
    notice: (t: string) => { calls.notices.push(t); },
  };
  return { host, calls };
}

test("a link in a session goes to its browser, http or https", async () => {
  for (const u of ["https://a.test/x", "http://localhost:3000/"]) {
    const r = linkRoute(web(u), "code:1", true);
    assert.deepEqual(r, { to: "session", session: "code:1", url: web(u).toString() });
    const { host, calls } = fake(async () => ({ ok: true, data: null }));
    await followLink(r!, host);
    assert.deepEqual(calls.opened, [["code:1", web(u).toString()]]);
    assert.deepEqual(calls.external, []);
    assert.deepEqual(calls.notices, []);
  }
});

test("outside a session https goes out and http shows the notice; the same with Computer off", async () => {
  for (const [session, on] of [[null, true], [null, false], ["code:1", false]] as const) {
    const s = linkRoute(web("https://a.test/"), session, on);
    assert.deepEqual(s, { to: "outside", url: "https://a.test/" });
    const h = linkRoute(web("http://a.test/"), session, on);
    assert.deepEqual(h, { to: "notice", text: HTTP_NOTICE });
    const { host, calls } = fake();
    await followLink(s!, host);
    await followLink(h!, host);
    assert.deepEqual(calls.external, ["https://a.test/"]);
    assert.deepEqual(calls.notices, [HTTP_NOTICE]);
  }
});

test("a link the session's browser refuses is opened nowhere", async () => {
  const route = linkRoute(web("https://user:pass@example.com/"), "code:1", true)!;
  const refused = fake(async () => ({ ok: false, code: "EINVAL", error: "no" }));
  await followLink(route, refused.host);
  assert.deepEqual(refused.calls.notices, [REFUSED_NOTICE]);
  assert.deepEqual(refused.calls.external, []);

  // No session browser to use (EPERM): the link goes the way a link outside a session does.
  const other = fake(async () => ({ ok: false, code: "EPERM", error: "off" }));
  await followLink(linkRoute(web("https://a.test/"), "code:1", true)!, other.host);
  await followLink(linkRoute(web("http://a.test/"), "code:1", true)!, other.host);
  assert.deepEqual(other.calls.external, ["https://a.test/"]);
  assert.deepEqual(other.calls.notices, [HTTP_NOTICE]);

  // The browser was there and the link did not open (the app is quitting, no tab could be made, an unknown code, a
  // rejected call): a notice, and nothing opens outside.
  const failures: Array<() => Promise<unknown>> = [
    async () => ({ ok: false, code: "ENOENT", error: "quitting" }),
    async () => ({ ok: false, code: "EIO", error: "no tab" }),
    async () => ({ ok: false, code: "EWHAT", error: "?" }),
    async () => { throw new Error("rejected"); },
  ];
  for (const f of failures) {
    const failed = fake(f);
    await followLink(linkRoute(web("https://a.test/"), "code:1", true)!, failed.host);
    await followLink(linkRoute(web("http://a.test/"), "code:1", true)!, failed.host);
    assert.deepEqual(failed.calls.external, []);
    assert.deepEqual(failed.calls.notices, [LINK_FAILED, LINK_FAILED]);
  }

  // No computer at all: the same fallback.
  const none = fake();
  await followLink({ to: "session", session: "code:1", url: "http://a.test/" }, none.host);
  assert.deepEqual(none.calls.notices, [HTTP_NOTICE]);
});

test("a link in a past conversation's chat goes outside, though a terminal is active", async () => {
  assert.equal(sessionForLink("live", "code:1"), "code:1");
  assert.equal(sessionForLink("live", null), null);
  assert.equal(sessionForLink("past", "code:1"), null);
  const past = sessionForLink("past", "code:1");
  assert.deepEqual(linkRoute(web("https://a.test/"), past, true), { to: "outside", url: "https://a.test/" });
  assert.deepEqual(linkRoute(web("http://a.test/"), past, true), { to: "notice", text: HTTP_NOTICE });
  const { host, calls } = fake(async () => ({ ok: true, data: null }));
  await followLink(linkRoute(web("https://a.test/"), past, true)!, host);
  assert.deepEqual(calls.opened, []);
});

test("agenticos: and file links are not web links", () => {
  for (const u of ["agenticos://workbench?tab=todo", "file:///etc/hosts", "javascript:alert(1)", "mailto:a@example.com"]) {
    assert.equal(linkRoute(web(u), "code:1", true), null);
  }
});
