import { test } from "node:test";
import assert from "node:assert/strict";
import { listen, Emitter } from "./listen";

interface Ref { name: string; cb: (...data: unknown[]) => unknown }

/** A stand-in for Obsidian's Events: on() hands back a ref, offref() drops it, trigger() calls what is left. */
function fakeEmitter(): Emitter<Ref> & { live: Ref[]; trigger(name: string, ...data: unknown[]): void } {
  const live: Ref[] = [];
  return {
    live,
    on(name, cb) { const ref = { name, cb }; live.push(ref); return ref; },
    offref(ref) { const i = live.indexOf(ref); if (i !== -1) live.splice(i, 1); },
    trigger(name, ...data) { for (const r of [...live]) if (r.name === name) r.cb(...data); },
  };
}

test("listen subscribes every handler and dispose removes them all", () => {
  const bus = fakeEmitter();
  const seen: string[] = [];
  const dispose = listen(bus, {
    "session-add": () => { seen.push("add"); },
    "session-remove": (id) => { seen.push(`remove:${String(id)}`); },
    "session-exit": () => { seen.push("exit"); },
  });
  assert.equal(bus.live.length, 3);
  bus.trigger("session-remove", "t1");
  bus.trigger("session-add");
  assert.deepEqual(seen, ["remove:t1", "add"]);

  dispose();
  assert.equal(bus.live.length, 0);
  bus.trigger("session-add");
  assert.deepEqual(seen, ["remove:t1", "add"], "a disposed handler never fires");
});

test("mounting and unmounting over and over leaves no listener behind", () => {
  const bus = fakeEmitter();
  for (let visit = 0; visit < 5; visit++) {
    const dispose = listen(bus, { "session-add": () => undefined, "session-remove": () => undefined, "session-exit": () => undefined });
    dispose();
  }
  assert.equal(bus.live.length, 0);
});

test("dispose is idempotent and leaves other owners' listeners alone", () => {
  const bus = fakeEmitter();
  const other = listen(bus, { "session-add": () => undefined });
  const dispose = listen(bus, { "session-add": () => undefined, "session-exit": () => undefined });
  dispose();
  dispose();
  assert.equal(bus.live.length, 1, "only the other owner's listener remains");
  other();
  assert.equal(bus.live.length, 0);
});
