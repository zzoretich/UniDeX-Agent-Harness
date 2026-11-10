// The Code tab's chat state: the cache tail, the rows from the events and the status text (spec 2026-11-09 code-chat).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { HostFs, HostSessionEvent } from "../host";
import { CacheTail, chatFromEvents, rowStatus, trimEvents } from "./codeChat";

const ev = (kind: string, turn: number, rest: Record<string, unknown> = {}): HostSessionEvent =>
  ({ t: "2026-11-09T10:00:00.000Z", kind, turn, ...rest }) as HostSessionEvent;

function turns(n: number, from = 1): HostSessionEvent[] {
  const out: HostSessionEvent[] = [];
  for (let i = from; i < from + n; i++) { out.push(ev("prompt", i, { text: `p${i}` })); out.push(ev("text", i, { text: `a${i}` })); }
  return out;
}

test("1000 turns keep 400 rows, cut at a turn boundary, and count what is hidden", () => {
  const s = chatFromEvents(turns(1000));
  assert.equal(s.rows.length, 400);
  assert.equal(s.hiddenEarlier, 1600);
  assert.equal(s.rows[0].turn, 801);
  assert.equal(chatFromEvents(turns(10)).hiddenEarlier, 0);
});

test("the cut falls on a turn boundary, not through a turn", () => {
  const evs = [...turns(1, 1), ev("prompt", 2, { text: "p2" }), ev("text", 2, { text: "x" }), ev("text", 2, { text: "y" }), ev("text", 2, { text: "z" })];
  const s = chatFromEvents(evs, { maxRows: 4 });
  assert.deepEqual(s.rows.map((r) => r.turn), [2, 2, 2, 2]);
  assert.equal(s.hiddenEarlier, 2);
  // one turn longer than the cap is cut hard
  const big = chatFromEvents([ev("prompt", 1, { text: "p" }), ev("text", 1), ev("text", 1), ev("text", 1)], { maxRows: 2 });
  assert.equal(big.rows.length, 2);
  assert.equal(big.hiddenEarlier, 2);
});

test("a cut on a turn boundary that would keep fewer than half the cap falls back to a hard cut at the cap", () => {
  // turn 1: 2 rows, turn 2: 9 rows, turn 3: 2 rows; maxRows 10 → the first boundary after the excess (3) is turn 3's, which
  // would keep 2 rows: cut hard instead, keeping the newest 10.
  const evs = [ev("prompt", 1, { text: "p1" }), ev("text", 1, { text: "a" }), ev("prompt", 2, { text: "p2" })];
  for (let i = 0; i < 8; i++) evs.push(ev("text", 2, { text: `t${i}` }));
  evs.push(ev("prompt", 3, { text: "p3" }), ev("text", 3, { text: "z" }));
  const s = chatFromEvents(evs, { maxRows: 10 });
  assert.equal(s.rows.length, 10);
  assert.equal(s.hiddenEarlier, 3);
  assert.deepEqual(s.rows.map((r) => r.turn), [2, 2, 2, 2, 2, 2, 2, 2, 3, 3]);
});

test("host and root reach the rows: relative paths under the terminal's folder, the host's default model name", () => {
  const evs = [
    ev("prompt", 1, { text: "p", model: "gpt-5.5" }),
    ev("tool", 1, { id: "t1", name: "Edit", toolKind: "edit", filePath: "/work/demo/src/a.ts", summary: "{}" }),
    ev("done", 1, { ok: true }),
    ev("prompt", 2, { text: "q", model: null }),
  ];
  const s = chatFromEvents(evs, { host: "codex", root: "/work/demo" });
  const tool = s.rows.find((r) => r.kind === "tool") as { target: string };
  assert.equal(tool.target, "src/a.ts");
  const change = s.rows.find((r) => r.kind === "change") as { text: string };
  assert.equal(change.text, "Next turn on Codex default");
  // without them, the path stays absolute and Claude Code's default is named
  const plain = chatFromEvents(evs);
  assert.equal((plain.rows.find((r) => r.kind === "tool") as { target: string }).target, "/work/demo/src/a.ts");
  assert.equal((plain.rows.find((r) => r.kind === "change") as { text: string }).text, "Next turn on Default");
});

test("trimEvents keeps the newest events from a prompt, and the last session event it dropped", () => {
  const evs: HostSessionEvent[] = [ev("session", 0, { id: "s1", model: "m1" }), ...turns(10)];
  // 21 events; keep at most 8: the first prompt at or after index 13 is turn 7's (index 13)
  const t = trimEvents(evs, 8);
  assert.equal(t.dropped, 13);
  assert.equal(t.events[0].kind, "session");
  assert.equal(t.events[0].id, "s1");
  assert.deepEqual(t.events.slice(1).map((e) => e.turn), [7, 7, 8, 8, 9, 9, 10, 10]);
  // under the bound nothing changes
  assert.deepEqual(trimEvents(evs, 100), { events: evs, dropped: 0 });
  // no prompt in the window: a hard cut at the bound
  const texts = Array.from({ length: 12 }, (_, i) => ev("text", 1, { text: `x${i}` }));
  const h = trimEvents(texts, 5);
  assert.equal(h.dropped, 7);
  assert.deepEqual(h.events.map((e) => e.text), ["x7", "x8", "x9", "x10", "x11"]);
  // a session kept in the window needs no copy
  const late = [...turns(5), ev("session", 5, { id: "s2" }), ...turns(2, 6)];
  const k = trimEvents(late, 7);
  assert.equal(k.dropped, 8);
  assert.equal(k.events[0].kind, "prompt");
  assert.equal(k.events.filter((e) => e.kind === "session").length, 1);
  assert.equal(chatFromEvents(k.events).sessionId, "s2");
});

test("a session event with a new id resets; the same id only updates the model", () => {
  const evs = [ev("session", 0, { id: "s1", model: "m1" }), ...turns(2), ev("session", 2, { id: "s1", model: "m2" })];
  let s = chatFromEvents(evs);
  assert.equal(s.sessionId, "s1");
  assert.equal(s.rows.length, 4);
  assert.equal(s.model, "m2");
  s = chatFromEvents([...evs, ev("session", 0, { id: "s2", model: "m3" }), ev("prompt", 1, { text: "fresh" })]);
  assert.equal(s.sessionId, "s2");
  assert.equal(s.rows.length, 1);
  assert.equal(s.model, "m3");
  assert.equal(s.hiddenEarlier, 0);
});

test("done events carry the model; a null t is accepted", () => {
  const s = chatFromEvents([{ ...ev("prompt", 1, { text: "p" }), t: null } as unknown as HostSessionEvent, ev("done", 1, { ok: true, model: "opus" })]);
  assert.equal(s.model, "opus");
  assert.equal(s.turnOpen, false);
  assert.equal((s.rows[1] as { ms: number | null }).ms, null);
});

test("an error event sets error and a later event clears it", () => {
  const e = ev("error", 0, { message: "Can't tell which conversation · Terminal ⌘J" });
  assert.equal(chatFromEvents([e]).error, "Can't tell which conversation · Terminal ⌘J");
  assert.equal(chatFromEvents([e, ...turns(1)]).error, null);
  assert.equal(chatFromEvents([...turns(1), e]).error, "Can't tell which conversation · Terminal ⌘J");
});

test("turnOpen is true after a prompt with no done", () => {
  assert.equal(chatFromEvents([ev("prompt", 1, { text: "p" })]).turnOpen, true);
  assert.equal(chatFromEvents([ev("prompt", 1, { text: "p" }), ev("done", 1, { ok: true })]).turnOpen, false);
});

// A one-file fake of HostFs: bytes of a file that tests grow and shrink.
function fakeFs() {
  const state: { bytes: Buffer | null } = { bytes: null };
  const fs = {
    statSync: (_p: string) => { if (!state.bytes) throw Object.assign(new Error("no"), { code: "ENOENT" }); return { size: state.bytes.length }; },
    readBytesSync: (_p: string, pos: number, len: number) => new Uint8Array(state.bytes!.subarray(pos, pos + len)),
  } as unknown as HostFs;
  return { fs, state };
}

test("CacheTail: nothing for a missing file or a half line, the line once complete", () => {
  const { fs, state } = fakeFs();
  const tail = new CacheTail(fs, "/cache/a.jsonl");
  assert.deepEqual(tail.read(), []);
  state.bytes = Buffer.from('{"kind":"text","turn":1,"t":null');
  assert.deepEqual(tail.read(), []);
  state.bytes = Buffer.from('{"kind":"text","turn":1,"t":null}\n{"kind":"prompt"');
  assert.deepEqual(tail.read(), [{ kind: "text", turn: 1, t: null }]);
  state.bytes = Buffer.from('{"kind":"text","turn":1,"t":null}\n{"kind":"prompt","turn":2}\nnot json\n{"kind":"done","turn":2}\n');
  assert.deepEqual(tail.read().map((e) => e.kind), ["prompt", "done"]);
  assert.deepEqual(tail.read(), []);
  assert.equal(tail.truncated, false);
});

test("CacheTail never splits a multi-byte character", () => {
  const { fs, state } = fakeFs();
  const tail = new CacheTail(fs, "/cache/a.jsonl");
  const line = Buffer.from('{"kind":"text","turn":1,"text":"é⌘"}\n');
  state.bytes = line.subarray(0, line.indexOf(0xe2) + 1);
  assert.deepEqual(tail.read(), []);
  state.bytes = line;
  assert.equal(tail.read()[0].text, "é⌘");
});

test("CacheTail: a shrunk file restarts at 0 and says so; reset() rewinds", () => {
  const { fs, state } = fakeFs();
  const tail = new CacheTail(fs, "/cache/a.jsonl");
  state.bytes = Buffer.from('{"kind":"text","turn":1}\n{"kind":"text","turn":2}\n');
  assert.equal(tail.read().length, 2);
  state.bytes = Buffer.from('{"kind":"prompt","turn":1}\n');
  assert.deepEqual(tail.read().map((e) => e.kind), ["prompt"]);
  assert.equal(tail.truncated, true);
  assert.deepEqual(tail.read(), []);
  assert.equal(tail.truncated, false);
  tail.reset();
  assert.equal(tail.read().length, 1);
});

test("rowStatus: exited > needs > working > idle", () => {
  const base = { exited: false, exitCode: null, turnOpen: false, printing: false, needsYou: false };
  assert.deepEqual(rowStatus(base), { status: "idle", text: "Idle" });
  assert.deepEqual(rowStatus({ ...base, turnOpen: true, printing: true }), { status: "working", text: "Working" });
  assert.deepEqual(rowStatus({ ...base, turnOpen: true }), { status: "working", text: "Working" });
  assert.deepEqual(rowStatus({ ...base, printing: true }), { status: "idle", text: "Idle" });
  assert.deepEqual(rowStatus({ ...base, turnOpen: true, printing: true, needsYou: true }), { status: "needs", text: "Needs you" });
  assert.deepEqual(rowStatus({ ...base, needsYou: true, exited: true, exitCode: 2 }), { status: "exited", text: "Exited 2" });
  assert.deepEqual(rowStatus({ ...base, exited: true }), { status: "exited", text: "Exited" });
  assert.deepEqual(rowStatus({ ...base, exited: true, exitCode: 0 }), { status: "exited", text: "Exited 0" });
});
