import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import type * as Open from "./openWebLink";

// openWebLink imports Notice from "obsidian": under node:test that resolves to a stub. The router takes the function that
// follows a link, so these tests fake it and need no host.
const STUB = "obsidian-stub-openweblink";
const M = Module as unknown as { _resolveFilename(request: string, ...rest: unknown[]): string };
const resolve = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "obsidian" ? STUB : resolve.call(this, request, ...rest);
};
class Stub {}
require.cache[STUB] = { id: STUB, filename: STUB, loaded: true, exports: { Notice: Stub } } as unknown as NodeJS.Module;
const { routeWebLinks } = require("./openWebLink") as typeof Open;

type Listener = (e: FakeEvent) => void;
interface FakeEvent { target: unknown; defaultPrevented: boolean; stopped: boolean; preventDefault(): void; stopPropagation(): void }

// A container with a capture-phase listener of the router's and a child root with its own bubble-phase listener, as the
// markdown renderer's is. A click runs the capture listeners first and reaches the child's only if nothing stopped it.
function setup(href: string | null) {
  const capture: Listener[] = [];
  const container = { addEventListener: (t: string, fn: Listener, c?: boolean | { capture?: boolean }) => {
    assert.equal(t, "click");
    assert.ok(c === true || (typeof c === "object" && c.capture === true), "the router listens in the capture phase");
    capture.push(fn);
  } } as unknown as HTMLElement;
  const anchor = href === null ? null : { getAttribute: (n: string) => (n === "href" ? href : null) };
  const target = { closest: (sel: string) => (sel === "a[href]" ? anchor : null) };
  let inner = 0;
  const click = (): FakeEvent => {
    const e: FakeEvent = {
      target, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; },
    };
    for (const fn of capture) fn(e);
    if (!e.stopped) inner++;
    return e;
  };
  return { container, click, inner: () => inner, listeners: () => capture.length };
}

test("a routed link is handled once: the renderer's own listener never sees the click", () => {
  const { container, click, inner } = setup("https://a.test/");
  const followed: Array<[string, string | null]> = [];
  routeWebLinks(container, () => "chat:1", (u, s) => { followed.push([u.toString(), s]); return true; });
  const e = click();
  assert.deepEqual(followed, [["https://a.test/", "chat:1"]]);
  assert.equal(inner(), 0);
  assert.equal(e.defaultPrevented, true);
  assert.equal(e.stopped, true);
});

test("a link that is not a web link is left to its own listener", () => {
  for (const href of ["agenticos://workbench?tab=pulse", "#", "notes/a.md", ""]) {
    const { container, click, inner } = setup(href);
    let calls = 0;
    // The real follow returns false for a non-web scheme; a relative href never gets that far.
    routeWebLinks(container, () => null, (u) => { calls++; return u.protocol === "http:" || u.protocol === "https:"; });
    const e = click();
    assert.equal(inner(), 1, href);
    assert.equal(e.defaultPrevented, false, href);
    assert.equal(e.stopped, false, href);
    assert.ok(calls <= 1, href);
  }
  // A click that is not on a link at all.
  const { container, click, inner } = setup(null);
  routeWebLinks(container, () => null, () => { throw new Error("no link was clicked"); });
  click();
  assert.equal(inner(), 1);
});

test("the session is read at click time", () => {
  const { container, click } = setup("https://a.test/");
  let session: string | null = "chat:1";
  let reads = 0;
  const seen: Array<string | null> = [];
  routeWebLinks(container, () => { reads++; return session; }, (_u, s) => { seen.push(s); return true; });
  assert.equal(reads, 0);
  click();
  session = null;
  click();
  assert.equal(reads, 2);
  assert.deepEqual(seen, ["chat:1", null]);
});

test("a container takes the router once", () => {
  const { container, listeners } = setup("https://a.test/");
  routeWebLinks(container, () => null, () => true);
  routeWebLinks(container, () => null, () => true);
  assert.equal(listeners(), 1);
});
