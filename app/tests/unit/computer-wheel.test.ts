import { test } from "node:test";
import assert from "node:assert/strict";
import { Wheel, type Holder } from "../../src/main/computer/wheel";
import type { Clock } from "../../src/main/computer/asks";

class FakeClock implements Clock {
  t = 0; private n = 0; private q = new Map<number, { at: number; fn: () => void }>();
  now() { return this.t; }
  setTimeout(fn: () => void, ms: number) { const id = ++this.n; this.q.set(id, { at: this.t + ms, fn }); return id; }
  clearTimeout(id: unknown) { this.q.delete(id as number); }
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const next = [...this.q.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.q.delete(next[0]); this.t = next[1].at; next[1].fn();
    }
    this.t = end;
  }
}

function make(reserved = false) {
  const clock = new FakeClock(); const log: Array<[string, Holder]> = []; const state = { reserved };
  const w = new Wheel({ clock, reserved: () => state.reserved, onChange: (c, h) => log.push([c, h]) });
  return { clock, log, w, state };
}

test("the first take holds the wheel; a second session is busy with the holder's label", () => {
  const { w } = make();
  assert.deepEqual(w.take("c", "s1", "Alpha"), { ok: true });
  assert.deepEqual(w.holder("c"), { kind: "agent", session: "s1", label: "Alpha" });
  assert.deepEqual(w.take("c", "s2", "Beta"), { ok: false, busy: "Alpha is driving" });
  assert.deepEqual(w.take("c", "s1", "Alpha"), { ok: true });
});

test("30 s idle frees the wheel; take and touch refresh the timer", () => {
  const { w, clock } = make();
  w.take("c", "s1", "A");
  clock.advance(29_000); w.touch("c", "s1");
  clock.advance(29_000); assert.notEqual(w.holder("c"), null);
  w.take("c", "s1", "A"); clock.advance(29_000); assert.notEqual(w.holder("c"), null);
  clock.advance(1_000); assert.equal(w.holder("c"), null);
});

test("a reserved computer never frees by idle", () => {
  const { w, clock, state } = make(true);
  w.take("c", "s1", "A");
  clock.advance(120_000); assert.notEqual(w.holder("c"), null);
  state.reserved = false; clock.advance(30_000); assert.equal(w.holder("c"), null);
});

test("turnEnded frees what that session holds", () => {
  const { w } = make();
  w.take("c", "s1", "A"); w.take("d", "s2", "B");
  w.turnEnded("s1");
  assert.equal(w.holder("c"), null); assert.notEqual(w.holder("d"), null);
});

test("takeOver makes the user the holder and handBack restores the agent", () => {
  const { w, log } = make();
  w.take("c", "s1", "A");
  w.takeOver("c");
  assert.deepEqual(w.holder("c"), { kind: "user", resume: { session: "s1", label: "A" } });
  assert.deepEqual(w.take("c", "s1", "A"), { ok: false, busy: "the user is driving" });
  w.handBack("c");
  assert.deepEqual(w.holder("c"), { kind: "agent", session: "s1", label: "A" });
  assert.equal(log.length, 3);
});

test("takeOver on a free wheel resumes nothing; handBack frees it", () => {
  const { w } = make();
  w.takeOver("c"); assert.deepEqual(w.holder("c"), { kind: "user", resume: null });
  w.handBack("c"); assert.equal(w.holder("c"), null);
});

test("turnEnded clears a user holder's resume that points at that session", () => {
  const { w } = make();
  w.take("c", "s1", "A"); w.takeOver("c"); w.turnEnded("s1");
  assert.deepEqual(w.holder("c"), { kind: "user", resume: null });
  w.handBack("c"); assert.equal(w.holder("c"), null);
});

test("R81: Take over, Hand back and the end of a turn bump the computer's generation; taking, touching and idling do not", () => {
  const { w, clock } = make();
  assert.equal(w.gen("c"), 0);
  w.take("c", "s1", "A"); w.touch("c", "s1");
  assert.equal(w.gen("c"), 0, "taking and touching keep it");
  w.takeOver("c");
  assert.equal(w.gen("c"), 1);
  w.handBack("c");
  assert.equal(w.gen("c"), 2, "the same session holds the wheel again, under a new generation");
  w.handBack("c");
  assert.equal(w.gen("c"), 2, "a Hand back that hands nothing back changes nothing");
  w.take("d", "s2", "B");
  w.turnEnded("s1");
  assert.deepEqual([w.gen("c"), w.gen("d")], [3, 0], "only the computers the session held or would resume");
  w.take("c", "s2", "B"); w.takeOver("c"); w.turnEnded("s2");
  assert.equal(w.gen("c"), 5, "a turn whose computer the user took over still ends under a new generation");
  w.handBack("c"); w.take("c", "s3", "C");
  const before = w.gen("c");
  clock.advance(30_000);
  assert.equal(w.holder("c"), null);
  assert.equal(w.gen("c"), before, "the idle free is not a cancellation (nothing runs then)");
});
