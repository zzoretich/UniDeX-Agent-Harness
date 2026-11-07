import { test } from "node:test";
import assert from "node:assert/strict";
import { AskBroker, type AskInput, type Ask, type Clock } from "../../src/main/computer/asks";

class FakeClock implements Clock {
  t = 0; private n = 0; private q = new Map<number, { at: number; fn: () => void }>();
  now() { return this.t; }
  setTimeout(fn: () => void, ms: number) { const id = ++this.n; this.q.set(id, { at: this.t + ms, fn }); return id; }
  clearTimeout(id: unknown) { this.q.delete(id as number); }
  async advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const next = [...this.q.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.q.delete(next[0]); this.t = next[1].at; next[1].fn();
      await Promise.resolve();
    }
    this.t = end; await Promise.resolve();
  }
}

const input: AskInput = { computer: "c1", session: "s1", sessionLabel: "Agent", why: "submit", title: "Submit", detail: "d", site: "https://a.test" };
function make() {
  const clock = new FakeClock(); const changes: Ask[][] = [];
  const b = new AskBroker({ timeoutMs: () => 120_000, clock, onChange: (p) => changes.push([...p]) });
  return { clock, changes, b };
}

test("an answer settles allowed", async () => {
  const { b } = make();
  const p = b.hold(input);
  const id = b.pending()[0].id;
  assert.equal(b.answer(id, "once"), true);
  assert.deepEqual(await p, { state: "allowed", askId: id, answer: "once" });
  assert.equal(b.pending().length, 0);
});

test("a deny answer settles denied", async () => {
  const { b } = make();
  const p = b.hold(input); const id = b.pending()[0].id;
  b.answer(id, "deny");
  assert.deepEqual(await p, { state: "denied", askId: id, answer: "deny" });
});

test("with no answer the hold gives waiting_for_user at 45 s, and the ask stays", async () => {
  const { b, clock } = make();
  const p = b.hold(input); const id = b.pending()[0].id;
  await clock.advance(44_999);
  assert.equal(b.pending().length, 1);
  await clock.advance(1);
  assert.deepEqual(await p, { state: "waiting_for_user", askId: id });
  assert.equal(b.pending().length, 1);
});

test("wait then an answer gives allowed", async () => {
  const { b, clock } = make();
  const first = b.hold(input); const id = b.pending()[0].id;
  await clock.advance(45_000); await first;
  const w = b.wait(id);
  b.answer(id, "always");
  assert.deepEqual(await w, { state: "allowed", askId: id, answer: "always" });
});

test("no answer by 120 s from creation gives denied and clears the ask", async () => {
  const { b, clock } = make();
  const first = b.hold(input); const id = b.pending()[0].id;
  await clock.advance(45_000); await first;
  await clock.advance(30_000);
  const w = b.wait(id);
  await clock.advance(45_000);
  const r = await w;
  assert.equal(r.state, "denied"); assert.equal(r.askId, id);
  assert.equal(b.pending().length, 0);
});

test("cancel settles denied with its reason", async () => {
  const { b } = make();
  const p = b.hold(input); const id = b.pending()[0].id;
  assert.equal(b.cancel((a) => a.session === "s1", "the turn ended"), 1);
  assert.deepEqual(await p, { state: "denied", askId: id, reason: "the turn ended" });
});

test("onChange fires on add, answer, cancel and expiry", async () => {
  const { b, changes, clock } = make();
  const p = b.hold(input); assert.equal(changes.length, 1); assert.equal(changes[0].length, 1);
  b.answer(b.pending()[0].id, "once"); await p; assert.equal(changes.length, 2); assert.equal(changes[1].length, 0);
  const p2 = b.hold(input); b.cancel(() => true, "x"); await p2; assert.equal(changes.length, 4);
  const p3 = b.hold(input); await clock.advance(45_000); await p3; await clock.advance(75_000);
  assert.equal(changes.length, 6); assert.equal(changes[5].length, 0);
});

test("an unknown id waits as denied; ids are unguessable; pending filters by computer", async () => {
  const { b } = make();
  const r = await b.wait("nope");
  assert.equal(r.state, "denied");
  assert.equal(b.answer("nope", "once"), false);
  void b.hold(input); void b.hold({ ...input, computer: "c2" });
  const [a, c] = b.pending();
  assert.match(a.id, /^[0-9a-f-]{36}$/); assert.notEqual(a.id, c.id);
  assert.equal(b.pending("c2").length, 1);
});
