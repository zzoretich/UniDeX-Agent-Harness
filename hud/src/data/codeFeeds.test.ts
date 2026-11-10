// Each agent terminal's chat (spec 2026-11-09 code-chat C1, C5; rulings R3, R28, R31): followed once with its first
// process's id and its key, unfollowed when it closes; its cache read on each vault change into a bounded buffer; its
// status line copy read whenever it changes; its view remembered. A fake HudHost stands in for main's terminals and its
// follower; the caches are real files in a temp vault.
import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import type * as PoolModule from "./terminalPool";
import type * as FeedsModule from "./codeFeeds";
import { setHudHost, type HostPtyAgentResult, type HostPtyProcess, type HostResult, type HudHost } from "../host";
import { createNodeHost } from "../nodeHost";
import type { LaunchSpec, Place } from "./terminalLaunch";

// "obsidian" resolves to a stub whose Events is enough for the pool's triggers (terminalSession.test.ts's pattern).
class FakeEvents {
  private handlers = new Map<string, Array<(...a: unknown[]) => void>>();
  on(name: string, cb: (...a: unknown[]) => void): { name: string; cb: (...a: unknown[]) => void } {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), cb]);
    return { name, cb };
  }
  offref(ref: { name: string; cb: (...a: unknown[]) => void }): void {
    this.handlers.set(ref.name, (this.handlers.get(ref.name) ?? []).filter((c) => c !== ref.cb));
  }
  trigger(name: string, ...data: unknown[]): void { for (const cb of this.handlers.get(name) ?? []) cb(...data); }
}
const STUB = "obsidian-stub-code-feeds";
const M = Module as unknown as { _resolveFilename(request: string, ...rest: unknown[]): string };
const resolve = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "obsidian" ? STUB : resolve.call(this, request, ...rest);
};
require.cache[STUB] = { id: STUB, filename: STUB, loaded: true, exports: { Events: FakeEvents } } as unknown as NodeJS.Module;
const { TerminalPool } = require("./terminalPool") as typeof PoolModule;
const { CodeFeeds, EVENT_CAP, IMAGE_ATTACH_MS, ROW_CAP, POLL_MS, PRINT_MS, SEND_POLL_MS, SEND_QUIET_MS, SEND_SETTLE_MS, SLASH_SETTLE_MS, imageMarks, screenDue, sendQuietWait, sendWait } = require("./codeFeeds") as typeof FeedsModule;

const KEY = "aaaaaaaa-0000-4000-8000-000000000001";
const SID = "cccccccc-0000-4000-8000-000000000003";

type Proc = HostPtyProcess & { exit(code?: number): void; emit(d: string): void; writes: string[] };
let nextPty = 0;
function proc(): Proc {
  const exit: Array<(e: { exitCode: number }) => void> = [];
  const data: Array<(d: string) => void> = [];
  const writes: string[] = [];
  return {
    pid: 1000 + nextPty, id: `t${++nextPty}`,
    write: (d) => { writes.push(d); }, resize: () => {}, kill: () => {},
    onData: (cb) => { data.push(cb); }, onExit: (cb) => { exit.push(cb); },
    exit: (code = 0) => { for (const cb of exit) cb({ exitCode: code }); },
    emit: (d) => { for (const cb of data) cb(d); },
    writes,
  };
}

/** A clock the test moves by hand (CodeFeeds' screen poll): `fire()` runs the poll now, `advance(ms)` moves time first. */
function manualClock() {
  let now = 1_000_000;
  let run: (() => void) | null = null;
  let every = 0;
  return {
    now: () => now,
    every: (ms: number, fn: () => void) => { every = ms; run = fn; return () => { if (run === fn) run = null; }; },
    get running() { return run !== null; },
    get ms() { return every; },
    fire() { run?.(); },
    advance(ms: number) { now += ms; run?.(); },
    /** Moves time without running the poll (a tick that has not come yet). */
    move(ms: number) { now += ms; },
  };
}
type Clock = ReturnType<typeof manualClock>;

interface Follow { pty: string; host: string; terminal: string; id?: string | null }
/** A host whose terminals and follower are fakes over a temp vault; `answer` is main's reply to follow. */
function setup(o: { code?: boolean; answer?: (r: Follow) => HostResult<{ cache: string; fresh: boolean }>; agent?: () => Promise<HostPtyAgentResult>; clock?: Clock } = {}) {
  const vault = fs.mkdtempSync(nodePath.join(os.tmpdir(), "aos-code-feeds-"));
  fs.mkdirSync(nodePath.join(vault, "brain", "_index", "code"), { recursive: true });
  fs.mkdirSync(nodePath.join(vault, "brain", "_index", "statusline"), { recursive: true });
  const follows: Follow[] = [];
  const unfollows: string[] = [];
  const shells: Proc[] = [];
  const node = createNodeHost();
  const host: HudHost = {
    ...node,
    pty: {
      loadError: () => null,
      spawn: () => { const p = proc(); shells.push(p); return p; },
      ...(o.agent ? { spawnAgent: () => o.agent!() } : {}),
    },
    code: {
      enabled: o.code ?? true,
      follow: async (req) => { follows.push(req); return o.answer ? o.answer(req) : { ok: true, data: { cache: `brain/_index/code/${req.terminal}.jsonl`, fresh: true } }; },
      unfollow: (pty) => { unfollows.push(pty); },
      view: async () => ({ ok: false, error: "", code: "EROFS" }),
    },
  };
  setHudHost(host);
  const pool = new TerminalPool({ shell: "/bin/zsh", cwd: vault });
  const feeds = new CodeFeeds(pool, { vaultRoot: () => vault, clock: o.clock ?? manualClock() });
  const changed: string[] = [];
  feeds.subscribe((id) => changed.push(id));
  const cache = (key = KEY) => nodePath.join(vault, "brain", "_index", "code", `${key}.jsonl`);
  const append = (lines: object[], key = KEY) => fs.appendFileSync(cache(key), lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
  return { vault, pool, feeds, follows, unfollows, shells, changed, cache, append, rel: (key = KEY) => `brain/_index/code/${key}.jsonl` };
}
const tick = () => new Promise((r) => setImmediate(r));
const ev = (kind: string, turn: number, rest: Record<string, unknown> = {}) => ({ t: "2026-11-09T10:00:00.000Z", kind, turn, ...rest });

test("an agent terminal is followed once, with its first process's id, its key and its conversation; a shell never; closing it unfollows", async () => {
  const h = setup();
  const shell = h.pool.create();
  const agent = h.pool.create({ meta: { host: "claude", terminalKey: KEY, sessionId: SID } });
  await tick();
  assert.equal(h.feeds.get(shell.id), null, "a shell has no chat (C3)");
  assert.deepEqual(h.follows, [{ pty: agent.originPty, host: "claude", terminal: KEY, id: SID }]);
  agent.setMeta({ label: "renamed" });
  agent.setTitle("A title");
  await tick();
  assert.equal(h.follows.length, 1, "once, however often the terminal changes");
  assert.equal(h.feeds.get(agent.id)?.follow, "on");
  h.pool.remove(agent.id);
  assert.deepEqual(h.unfollows, [agent.originPty]);
  assert.equal(h.feeds.get(agent.id), null);
  h.pool.remove(shell.id);
  assert.deepEqual(h.unfollows, [agent.originPty], "nothing for a shell");
});

test("a Code launch is followed once its agent runs, by the agent's id, and stays so after the login shell takes over (R28)", async () => {
  const agentProc = proc();
  let answer: (r: HostPtyAgentResult) => void = () => {};
  const h = setup({ agent: () => new Promise((r) => { answer = r; }) });
  const place: Place = { kind: "vault", label: "Vault", dir: h.vault };
  const spec: LaunchSpec = { host: "codex", bin: null, model: null, access: "edit", cwd: h.vault };
  const { session, ready } = h.pool.createAgent({ spec, place, meta: { host: "codex", place, terminalKey: KEY } });
  await tick();
  assert.deepEqual(h.follows, [], "no process yet, nothing to follow");
  assert.equal(h.feeds.get(session.id)?.follow, "pending");
  answer({ ok: true, data: agentProc });
  await ready;
  await tick();
  assert.deepEqual(h.follows, [{ pty: agentProc.id, host: "codex", terminal: KEY, id: null }]);
  agentProc.exit(0);
  assert.equal(h.shells.length, 1, "the login shell took over");
  await tick();
  assert.equal(h.follows.length, 1);
  assert.equal(session.originPty, agentProc.id, "still the agent's id, not the shell's");
  h.pool.remove(session.id);
  assert.deepEqual(h.unfollows, [agentProc.id]);
});

test("the cache is read on each change of its path: rows, a fresh follow starting over, a rewritten file clearing what was read", async () => {
  const h = setup();
  h.append([ev("session", 0, { id: SID, model: "opus" }), ev("prompt", 1, { text: "fix the parser" })]);
  const s = h.pool.create({ meta: { host: "claude", terminalKey: KEY } });
  await tick();
  const feed = () => h.feeds.get(s.id)!;
  assert.equal(feed().cache, h.rel());
  assert.deepEqual(feed().state.rows.map((r) => r.kind), ["prompt"]);
  assert.equal(feed().state.turnOpen, true);
  assert.equal(feed().state.model, "opus");
  h.changed.length = 0;
  h.append([ev("text", 1, { text: "On it." }), ev("done", 1, { ok: true })]);
  h.feeds.vaultChanged("brain/_index/code/other.jsonl");
  assert.deepEqual(h.changed, [], "another path changes nothing");
  h.feeds.vaultChanged(h.rel());
  assert.deepEqual(h.changed, [s.id]);
  assert.deepEqual(feed().state.rows.map((r) => r.kind), ["prompt", "text", "done"]);
  assert.equal(feed().state.turnOpen, false);
  h.feeds.vaultChanged(h.rel());
  assert.deepEqual(h.changed, [s.id], "nothing new, no change");
  // A replaced follower rewrites the file from the start: shorter, so the tail starts over.
  fs.writeFileSync(h.cache(), `${JSON.stringify(ev("session", 0, { id: "dddddddd-0000-4000-8000-000000000004" }))}\n`);
  h.feeds.vaultChanged(h.rel());
  assert.deepEqual(feed().state.rows, []);
  assert.equal(feed().state.sessionId, "dddddddd-0000-4000-8000-000000000004");
});

test("follow refused: off with the surface off (EROFS), failed with main's reason otherwise; with the surface off nothing is asked", async () => {
  let h = setup({ answer: () => ({ ok: false, error: "that terminal key is not this terminal's", code: "EINVAL" }) });
  let s = h.pool.create({ meta: { host: "claude", terminalKey: KEY } });
  await tick();
  assert.equal(h.feeds.get(s.id)?.follow, "failed");
  assert.equal(h.feeds.get(s.id)?.error, "that terminal key is not this terminal's");
  assert.equal(h.feeds.view(s.id), "chat", "the chat says why");
  h = setup({ code: false });
  s = h.pool.create({ meta: { host: "claude", terminalKey: KEY } });
  await tick();
  assert.deepEqual(h.follows, []);
  assert.equal(h.feeds.get(s.id)?.follow, "off");
  assert.equal(h.feeds.view(s.id), "terminal", "an agent opens in its terminal while the surface is off (C13)");
  assert.equal(h.feeds.get(s.id)?.status, null);
});

test("the buffer keeps the newest events from a prompt; Show earlier reads the whole cache once and adds ROW_CAP rows", async () => {
  const h = setup();
  const lines: object[] = [ev("session", 0, { id: SID })];
  const turns = EVENT_CAP;   // two events a turn: twice the cap in all
  for (let i = 1; i <= turns; i++) lines.push(ev("prompt", i, { text: `p${i}` }), ev("text", i, { text: `a${i}` }));
  h.append(lines);
  const s = h.pool.create({ meta: { host: "claude", terminalKey: KEY } });
  await tick();
  const feed = () => h.feeds.get(s.id)!;
  assert.equal(feed().state.rows.length, ROW_CAP);
  assert.ok(h.feeds.buffered(s.id) <= EVENT_CAP + 1, `at most the cap (and the kept session event): ${h.feeds.buffered(s.id)}`);
  assert.equal(h.feeds.buffered(s.id) % 2, 1, "cut at a prompt: whole turns, and the session event");
  assert.equal(feed().state.sessionId, SID, "the trimmed buffer keeps the conversation's id");
  assert.ok(feed().state.hiddenEarlier >= 2 * turns - ROW_CAP, "earlier rows are offered");
  assert.equal(feed().state.rows[ROW_CAP - 1].turn, turns);
  h.feeds.showEarlier(s.id);
  assert.equal(feed().state.rows.length, 2 * ROW_CAP);
  assert.equal(feed().state.hiddenEarlier, 2 * turns - 2 * ROW_CAP, "the whole cache is read: the count is exact");
  assert.equal(h.feeds.buffered(s.id), 2 * turns + 1);
  // what is appended after is read once, by the tail that Show earlier left at the end
  h.append([ev("prompt", turns + 1, { text: "next" })]);
  h.feeds.vaultChanged(h.rel());
  assert.equal(feed().state.rows.filter((r) => r.kind === "prompt" && r.text === "next").length, 1);
});

test("a Claude Code terminal's status line copy is read on each change and shown whenever it is there (R3); Codex has none yet", async () => {
  const h = setup();
  const claude = h.pool.create({ meta: { host: "claude", terminalKey: KEY } });
  const codex = h.pool.create({ meta: { host: "codex", terminalKey: "bbbbbbbb-0000-4000-8000-000000000002" } });
  await tick();
  assert.equal(h.feeds.get(claude.id)?.status, null, "no copy yet: the hint");
  const rel = `brain/_index/statusline/${KEY}.json`;
  const file = nodePath.join(h.vault, rel);
  // an old one shows too: no staleness rule (R3)
  fs.writeFileSync(file, JSON.stringify({ at: "2020-01-01T00:00:00.000Z", session_id: SID, transcript_path: null, ansi: "\u001b[32mOpus\u001b[0m │ demo\nline two\nline three\n" }));
  h.changed.length = 0;
  h.feeds.vaultChanged(rel);
  assert.deepEqual(h.changed, [claude.id]);
  const status = h.feeds.get(claude.id)!.status!;
  assert.equal(status.length, 3);
  assert.equal(status[0][0].text, "Opus");
  assert.equal(status[0][0].fg, "var(--udx-term-green)");
  h.feeds.vaultChanged(rel);
  assert.deepEqual(h.changed, [claude.id], "the same text changes nothing");
  fs.writeFileSync(file, "{ not json");
  h.feeds.vaultChanged(rel);
  assert.equal(h.feeds.get(claude.id)?.status, null, "unreadable: the hint");
  fs.rmSync(file);
  h.feeds.vaultChanged(rel);
  assert.equal(h.feeds.get(claude.id)?.status, null);
  assert.equal(h.feeds.get(codex.id)?.status, null);
});

test("each terminal remembers its view; a shell is always its terminal", async () => {
  const h = setup();
  const a = h.pool.create({ meta: { host: "claude", terminalKey: KEY } });
  const b = h.pool.create({ meta: { host: "codex", terminalKey: "bbbbbbbb-0000-4000-8000-000000000002" } });
  const sh = h.pool.create();
  assert.equal(h.feeds.view(a.id), "chat", "an agent opens in its chat (C1)");
  h.feeds.setView(a.id, "terminal");
  assert.equal(h.feeds.view(a.id), "terminal");
  assert.equal(h.feeds.view(b.id), "chat");
  h.feeds.setView(sh.id, "chat");
  assert.equal(h.feeds.view(sh.id), "terminal", "a shell has no chat (C3)");
  h.pool.remove(a.id);
  assert.equal(h.feeds.view(a.id), "terminal", "gone with its terminal");
});

test("a command that is not a conversation (chat: false, e.g. codex mcp login) has no feed, no follow and is always its terminal (R40 C)", async () => {
  const h = setup();
  const login = h.pool.create({ meta: { host: "codex", chat: false, terminalKey: KEY } });
  await tick();
  assert.equal(h.feeds.get(login.id), null, "no chat");
  assert.deepEqual(h.follows, [], "nothing followed");
  assert.equal(h.feeds.view(login.id), "terminal");
  h.feeds.setView(login.id, "chat");
  assert.equal(h.feeds.view(login.id), "terminal");
});

// ── each agent terminal's screen: the approval card, Needs you, Codex's status line (code-chat C4, C5, C10; Task 12) ──

const SCREENS = nodePath.join(__dirname, "fixtures", "screens");
const fixture = (name: string) => fs.readFileSync(nodePath.join(SCREENS, name), "utf8");
/** A rendered fixture screen as a stream that draws it from the top. */
const drawn = (name: string) => `\u001b[H\u001b[2J${fixture(`${name}.txt`).split("\n").join("\r\n")}`;
const KEY2 = "bbbbbbbb-0000-4000-8000-000000000002";
/** Runs the poll at the same time until `ok` (xterm parses on a timer), or fails after 2 s. */
async function until(clock: Clock, ok: () => boolean): Promise<void> {
  const end = Date.now() + 2000;
  while (!ok()) {
    if (Date.now() > end) assert.fail("the screen never got there");
    await new Promise((r) => setTimeout(r, 5));
    clock.fire();
  }
}

test("the poll: every POLL_MS, only while the PTY printed in the last PRINT_MS or a card is up", () => {
  assert.equal(POLL_MS, 500);
  assert.equal(PRINT_MS, 2000);
  assert.equal(screenDue(10_000, 9_000, false), true);
  assert.equal(screenDue(10_000, 8_001, false), true);
  assert.equal(screenDue(10_000, 8_000, false), false, "quiet for 2 s");
  assert.equal(screenDue(10_000, Number.NEGATIVE_INFINITY, false), false, "never printed");
  assert.equal(screenDue(10_000, Number.NEGATIVE_INFINITY, true), true, "a card is up");
});

test("an agent terminal has one headless screen while the surface is on; a shell, a chat: false command or the surface off has none; it goes with its terminal", async () => {
  const h = setup();
  const agent = h.pool.create({ meta: { host: "claude", terminalKey: KEY } });
  const shell = h.pool.create();
  const login = h.pool.create({ meta: { host: "codex", chat: false, terminalKey: KEY2 } });
  await tick();
  assert.equal(h.feeds.screened(agent.id), true);
  assert.equal(h.feeds.screened(shell.id), false);
  assert.equal(h.feeds.screened(login.id), false);
  h.pool.remove(agent.id);
  assert.equal(h.feeds.screened(agent.id), false);
  const off = setup({ code: false });
  const b = off.pool.create({ meta: { host: "claude", terminalKey: KEY } });
  assert.equal(off.feeds.screened(b.id), false, "the surface off: no chat, so no card and no screen");
});

test("an approval on an agent's screen is its card, read by the poll and never in the data's own tick; Needs you; the card holds the poll; a click writes the choice's key alone, once (C4, C10)", async () => {
  const clock = manualClock();
  const h = setup({ clock });
  const s = h.pool.create({ cols: 120, rows: 40, meta: { host: "claude", terminalKey: KEY } });
  await tick();
  const p = h.shells[h.shells.length - 1];
  const feed = () => h.feeds.get(s.id)!;
  assert.equal(clock.running, false, "a quiet terminal is not polled");
  assert.deepEqual([feed().card, feed().needsYou, feed().printing], [null, false, false]);
  h.changed.length = 0;
  p.emit(fixture("claude-2.1.318-bash.ansi"));
  assert.equal(feed().printing, true);
  assert.equal(clock.running, true, "it printed: polled");
  assert.equal(clock.ms, POLL_MS);
  clock.fire();
  assert.equal(feed().card, null, "nothing is decided from a screen xterm has not parsed yet");
  await until(clock, () => feed().card !== null);
  const card = feed().card!;
  assert.equal(card.kind, "approval");
  assert.equal(card.kind === "approval" ? card.title : null, "Do you want to proceed?");
  assert.equal(card.kind === "approval" ? card.detail : null, "touch hi.txt");
  assert.deepEqual(card.kind === "approval" ? card.choices.map((c) => c.key) : [], ["1", "2", "3", "4"]);
  assert.equal(feed().needsYou, true);
  assert.ok(h.changed.includes(s.id), "listeners hear of it");
  // Quiet now, but the card is up: still polled, and the same prompt is the same card (nothing to redraw).
  clock.advance(PRINT_MS);
  clock.advance(POLL_MS);
  assert.equal(feed().printing, false);
  assert.equal(clock.running, true);
  assert.equal(feed().card, card);
  // The click writes exactly the choice's key, once per prompt.
  p.writes.length = 0;
  assert.equal(await h.feeds.answer(s.id, "1"), true);
  assert.deepEqual(p.writes, ["1"]);
  assert.equal(await h.feeds.answer(s.id, "1"), false, "a second click on the same prompt writes nothing");
  assert.equal(await h.feeds.answer(s.id, "9"), false, "nor a key it does not offer");
  assert.deepEqual(p.writes, ["1"]);
  // The TUI moved on: the card goes, and with the PTY quiet and no card the poll stops.
  p.emit(drawn("claude-2.1.318-idle"));
  await until(clock, () => feed().card === null);
  assert.equal(feed().needsYou, false);
  clock.advance(PRINT_MS);
  assert.equal(clock.running, false, "quiet with no card: not polled");
});

test("Send asks cardNow: a prompt that just printed is read fresh, once parsed and within a bound; busy alone never holds (R49, R56)", async () => {
  const clock = manualClock();
  const h = setup({ clock });
  const s = h.pool.create({ cols: 120, rows: 40, meta: { host: "claude", terminalKey: KEY } });
  await tick();
  const p = h.shells[h.shells.length - 1];
  const feed = () => h.feeds.get(s.id)!;
  assert.equal(await h.feeds.cardNow(s.id), false, "a quiet terminal with no card: no hold");
  assert.equal(await h.feeds.cardNow("nope"), false);
  // (a) output streaming (a chunk pending), no card: Send goes through, within the bound.
  p.emit(drawn("claude-2.1.318-idle"));
  let t0 = Date.now();
  assert.equal(await h.feeds.cardNow(s.id), false, "busy with no card is not a hold");
  assert.ok(Date.now() - t0 <= SEND_SETTLE_MS + 50);
  // (b) the card is in the chunk just printed, the poll has not run: held, and the feed has it.
  p.emit(fixture("claude-2.1.318-bash.ansi"));
  assert.equal(feed().card, null, "the poll has not read it");
  assert.equal(await h.feeds.cardNow(s.id), true);
  assert.equal(feed().card?.kind, "approval");
  assert.equal(feed().needsYou, true);
  // A card already known holds without a read, however long ago it printed.
  clock.advance(PRINT_MS * 2);
  assert.equal(await h.feeds.cardNow(s.id), true);
  p.emit(drawn("claude-2.1.318-idle"));
  await until(clock, () => feed().card === null);
});

test("a prompt printed 400 ms ago that no poll has read holds Send (the poll may take POLL_MS and more to see it)", async () => {
  const clock = manualClock();
  const h = setup({ clock });
  const s = h.pool.create({ cols: 120, rows: 40, meta: { host: "claude", terminalKey: KEY } });
  await tick();
  const p = h.shells[h.shells.length - 1];
  const feed = () => h.feeds.get(s.id)!;
  p.emit(fixture("claude-2.1.318-bash.ansi"));
  const screen = (h.feeds as unknown as { entries: Map<string, { screen: { settled(ms: number): Promise<void> } }> }).entries.get(s.id)!.screen;
  await screen.settled(2000);
  clock.move(400);
  assert.equal(feed().card, null, "no poll has read it");
  p.writes.length = 0;
  assert.equal(await h.feeds.cardNow(s.id), true, "Send holds: its ⏎ would answer the prompt");
  assert.equal(feed().card?.kind, "approval");
  assert.equal(feed().needsYou, true);
  // The prompt answered in the terminal; quiet for long with an idle screen: read again, and nothing holds.
  p.emit(drawn("claude-2.1.318-idle"));
  await until(clock, () => feed().card === null);
  clock.move(PRINT_MS * 3);
  assert.equal(await h.feeds.cardNow(s.id), false);
  assert.equal(feed().card, null);
  assert.deepEqual(p.writes, [], "cardNow writes nothing");
});

test("a click while a chunk is still parsing waits for it (at most SEND_SETTLE_MS), then answers the prompt still up; one that went writes nothing", async () => {
  const clock = manualClock();
  const h = setup({ clock });
  const s = h.pool.create({ cols: 120, rows: 40, meta: { host: "claude", terminalKey: KEY } });
  await tick();
  const p = h.shells[h.shells.length - 1];
  p.emit(fixture("claude-2.1.318-bash.ansi"));
  await until(clock, () => h.feeds.get(s.id)!.card !== null);
  p.writes.length = 0;
  // A chunk that leaves the prompt as it was (the cursor hidden), still unparsed when the click lands.
  p.emit("\u001b[?25l");
  const t0 = Date.now();
  assert.equal(await h.feeds.answer(s.id, "1"), true);
  assert.ok(Date.now() - t0 <= SEND_SETTLE_MS + 50);
  assert.deepEqual(p.writes, ["1"]);
  // The next prompt, then a chunk that takes it away, unparsed when the click lands: after the wait it is gone.
  p.emit(drawn("claude-2.1.318-edit"));
  await until(clock, () => { const c = h.feeds.get(s.id)!.card; return c?.kind === "approval" && c.title !== "Do you want to proceed?"; });
  p.writes.length = 0;
  p.emit(drawn("claude-2.1.318-idle"));
  assert.equal(await h.feeds.answer(s.id, "1"), false);
  assert.deepEqual(p.writes, []);
});

test("Send never waits past SEND_SETTLE_MS on a screen that never settles (R56)", async () => {
  const clock = manualClock();
  const h = setup({ clock });
  const s = h.pool.create({ cols: 120, rows: 40, meta: { host: "claude", terminalKey: KEY } });
  await tick();
  const p = h.shells[h.shells.length - 1];
  p.emit(drawn("claude-2.1.318-idle"));
  const screen = (h.feeds as unknown as { entries: Map<string, { screen: object }> }).entries.get(s.id)!.screen;
  await new Promise((r) => setTimeout(r, 50)); // the real parse finishes; its callback is spent
  Object.defineProperty(screen, "busy", { get: () => true }); // and now a chunk that never parses
  const t0 = Date.now();
  assert.equal(await h.feeds.cardNow(s.id), false);
  const took = Date.now() - t0;
  assert.ok(took >= SEND_SETTLE_MS - 10 && took <= SEND_SETTLE_MS + 150, `took ${took} ms`);
});

test("R62: how long Send still waits for the terminal's last input: what is left of SEND_QUIET_MS, never more", () => {
  assert.equal(SEND_QUIET_MS, 500);
  assert.equal(sendQuietWait(Number.NEGATIVE_INFINITY, 10_000), 0, "no input yet");
  assert.equal(sendQuietWait(10_000, 10_020), 480);
  assert.equal(sendQuietWait(10_000, 10_500), 0);
  assert.equal(sendQuietWait(10_000, 10_600), 0);
  assert.equal(sendQuietWait(10_000, 9_000), SEND_QUIET_MS, "a clock that moved back waits no longer than the bound");
});

test("R62: Send 20 ms after input whose prompt the TUI draws 200 ms after it is held; 600 ms after the last input, with no prompt, it goes at once", async () => {
  const clock = manualClock();
  const h = setup({ clock });
  const s = h.pool.create({ cols: 120, rows: 40, meta: { host: "claude", terminalKey: KEY } });
  await tick();
  const p = h.shells[h.shells.length - 1];
  const feed = () => h.feeds.get(s.id)!;
  p.emit(drawn("claude-2.1.318-idle"));
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await sleep(50);
  assert.equal(await h.feeds.cardNow(s.id), false, "no input yet, no prompt: no hold");
  // `/model` and its ⏎ reach the TUI (Send, a card or the terminal: all go through write); its picker comes 200 ms later.
  s.write("/model\r");
  const wrote = Date.now();
  const picker = setTimeout(() => p.emit(drawn("claude-2.1.318-model")), 200);
  await sleep(20);
  assert.equal(feed().card, null, "nothing on its screen yet");
  const t0 = Date.now();
  assert.equal(await h.feeds.cardNow(s.id), true, "held: the draft's ⏎ would confirm the picker's highlighted model");
  const took = Date.now() - t0;
  // Read every SEND_POLL_MS while it waits: held once the picker is drawn, never past the bound.
  assert.ok(Date.now() - wrote >= 190, `held ${Date.now() - wrote} ms after the input, before the picker was drawn`);
  assert.ok(took <= SEND_QUIET_MS + SEND_SETTLE_MS + 50, `took ${took} ms`);
  assert.deepEqual(feed().card, { kind: "waiting" });
  clearTimeout(picker);
  // The picker closed in the terminal; 600 ms after that last input, with nothing up, Send goes at once.
  p.emit(drawn("claude-2.1.318-idle"));
  s.write("\u001b");
  await until(clock, () => feed().card === null);
  await sleep(600);
  const t1 = Date.now();
  assert.equal(await h.feeds.cardNow(s.id), false);
  assert.ok(Date.now() - t1 <= 50, `took ${Date.now() - t1} ms`);
  assert.deepEqual(p.writes, ["/model\r", "\u001b"], "cardNow writes nothing");
});

test("R69: how long Send may wait: SEND_QUIET_MS after any input, SLASH_SETTLE_MS after a slash command the composer sent, the longer of the two", () => {
  assert.equal(SLASH_SETTLE_MS, 2000);
  assert.equal(SEND_POLL_MS, 100);
  const none = Number.NEGATIVE_INFINITY;
  assert.equal(sendWait(none, none, 10_000), 0);
  assert.equal(sendWait(10_000, none, 10_050), 450, "no command: R62's quiet time");
  assert.equal(sendWait(10_000, 10_000, 10_050), 1950, "a command: its settle time");
  assert.equal(sendWait(11_900, 10_000, 11_950), 450, "input after the command, near its end: the quiet time is longer");
  assert.equal(sendWait(10_000, 10_000, 12_100), 0);
  assert.equal(sendWait(none, 10_000, 9_000), SLASH_SETTLE_MS, "a clock that moved back waits no longer than the bound");
});

test("R69: a Send 50 ms after a slash command waits for the prompt it opens however late (1200 ms here), at most SLASH_SETTLE_MS; after other input, SEND_QUIET_MS", async () => {
  const clock = manualClock();
  const h = setup({ clock });
  const s = h.pool.create({ cols: 120, rows: 40, meta: { host: "claude", terminalKey: KEY } });
  await tick();
  const p = h.shells[h.shells.length - 1];
  const feed = () => h.feeds.get(s.id)!;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  p.emit(drawn("claude-2.1.318-idle"));
  await sleep(50);
  // The composer sends `/model` (it notes the command, then writes it); the TUI draws its picker 1200 ms later.
  s.noteCommand();
  s.write("/model\r");
  const sent = Date.now();
  const picker = setTimeout(() => p.emit(drawn("claude-2.1.318-model")), 1200);
  await sleep(50);
  let t0 = Date.now();
  assert.equal(await h.feeds.cardNow(s.id), true, "held: past SEND_QUIET_MS, the picker still came");
  assert.ok(Date.now() - sent >= 1190, `held ${Date.now() - sent} ms after the command`);
  assert.ok(Date.now() - t0 <= SLASH_SETTLE_MS + SEND_SETTLE_MS + 50, `took ${Date.now() - t0} ms`);
  clearTimeout(picker);
  p.emit(drawn("claude-2.1.318-idle"));
  s.write("\u001b");
  await until(clock, () => feed().card === null);
  // A command that opens nothing: the Send goes once SLASH_SETTLE_MS has passed since it.
  s.noteCommand();
  s.write("/status\r");
  const quiet = Date.now();
  await sleep(50);
  t0 = Date.now();
  assert.equal(await h.feeds.cardNow(s.id), false);
  const after = Date.now() - quiet;
  assert.ok(after >= SLASH_SETTLE_MS - 20 && after <= SLASH_SETTLE_MS + SEND_SETTLE_MS + 80, `went ${after} ms after the command`);
  // Text that is no command (a reply, a key): R62's SEND_QUIET_MS alone.
  s.write("thanks\r");
  const typed = Date.now();
  await sleep(50);
  assert.equal(await h.feeds.cardNow(s.id), false);
  const waited = Date.now() - typed;
  assert.ok(waited >= SEND_QUIET_MS - 20 && waited <= SEND_QUIET_MS + SEND_SETTLE_MS + 80, `went ${waited} ms after the input`);
});

test("C1: the agent ending while Send waits is \"gone\", not clear: nothing may go to the login shell that took its terminal over", async () => {
  const clock = manualClock();
  const agentProc = proc();
  const h = setup({ clock, agent: async () => ({ ok: true, data: agentProc }) });
  const place: Place = { kind: "vault", label: "Vault", dir: h.vault };
  const spec: LaunchSpec = { host: "claude", bin: null, model: null, access: "edit", cwd: h.vault };
  const { session, ready } = h.pool.createAgent({ spec, place, meta: { host: "claude", place, terminalKey: KEY } });
  await ready;
  session.resize(120, 40);
  agentProc.emit(drawn("claude-2.1.318-idle"));
  await new Promise((r) => setTimeout(r, 50));
  // `/exit` from the composer: a Send right after it waits, and the agent ends meanwhile.
  session.noteCommand();
  session.write("/exit\r");
  const asked = h.feeds.cardNow(session.id);
  await new Promise((r) => setTimeout(r, 150));
  agentProc.exit(0);
  assert.equal(session.agentEnded, true, "the login shell took over");
  assert.equal(await asked, "gone");
  assert.deepEqual(h.shells[h.shells.length - 1].writes, [], "nothing reached the shell");
  // During the settle after the wait too: a screen whose chunk never parses, and the agent ends in that window.
  const agent2 = proc();
  const h2 = setup({ clock: manualClock(), agent: async () => ({ ok: true, data: agent2 }) });
  const two = h2.pool.createAgent({ spec, place, meta: { host: "claude", place, terminalKey: KEY2 } });
  await two.ready;
  agent2.emit(drawn("claude-2.1.318-idle"));
  await new Promise((r) => setTimeout(r, 50));
  const screen = (h2.feeds as unknown as { entries: Map<string, { screen: object }> }).entries.get(two.session.id)!.screen;
  Object.defineProperty(screen, "busy", { get: () => true });
  const settling = h2.feeds.cardNow(two.session.id);
  setTimeout(() => agent2.exit(0), 40);
  assert.equal(await settling, "gone");
});

test("R70: after Send pasted images, imagesShown waits for that many more placeholders on the screen (read every 50 ms), at most IMAGE_ATTACH_MS; gone if the agent ends", async () => {
  assert.equal(IMAGE_ATTACH_MS, 3000);
  assert.equal(imageMarks(["❯ [Image #1] [Image #2] look", "[Image #3]", "no image"]), 3);
  assert.equal(imageMarks([]), 0);
  const clock = manualClock();
  const h = setup({ clock });
  const s = h.pool.create({ cols: 120, rows: 40, meta: { host: "claude", terminalKey: KEY } });
  await tick();
  const p = h.shells[h.shells.length - 1];
  p.emit(drawn("claude-2.1.318-idle"));
  await new Promise((r) => setTimeout(r, 50));
  const before = h.feeds.imageMarks(s.id);
  assert.equal(before, 0);
  // Claude Code inserts the placeholder 300 ms after the paste.
  setTimeout(() => p.emit("\r\n❯ [Image #1] "), 300);
  let t0 = Date.now();
  assert.equal(await h.feeds.imagesShown(s.id, before!, 1), "attached");
  assert.ok(Date.now() - t0 >= 290 && Date.now() - t0 <= 300 + 150, `attached after ${Date.now() - t0} ms`);
  // Two more images, of which only one shows: the cap, then the text goes anyway.
  setTimeout(() => p.emit("[Image #2] "), 100);
  t0 = Date.now();
  assert.equal(await h.feeds.imagesShown(s.id, 1, 2), "timeout");
  assert.ok(Date.now() - t0 >= IMAGE_ATTACH_MS - 20 && Date.now() - t0 <= IMAGE_ATTACH_MS + 150, `gave up after ${Date.now() - t0} ms`);
  assert.equal(h.feeds.imageMarks("no-such-terminal"), null);
  assert.equal(await h.feeds.imagesShown("no-such-terminal", 0, 1), "gone");
  // The agent ends while Send waits for its images: gone, and nothing more may be written.
  const agentProc = proc();
  const h2 = setup({ clock: manualClock(), agent: async () => ({ ok: true, data: agentProc }) });
  const place: Place = { kind: "vault", label: "Vault", dir: h2.vault };
  const two = h2.pool.createAgent({ spec: { host: "claude", bin: null, model: null, access: "edit", cwd: h2.vault }, place, meta: { host: "claude", place, terminalKey: KEY2 } });
  await two.ready;
  agentProc.emit(drawn("claude-2.1.318-idle"));
  await new Promise((r) => setTimeout(r, 50));
  const waiting = h2.feeds.imagesShown(two.session.id, 0, 1);
  setTimeout(() => agentProc.exit(0), 120);
  assert.equal(await waiting, "gone");
});

test("a click answers the card the user saw: a card that was replaced meanwhile writes nothing (R49)", async () => {
  const clock = manualClock();
  const h = setup({ clock });
  const s = h.pool.create({ cols: 120, rows: 40, meta: { host: "claude", terminalKey: KEY } });
  await tick();
  const p = h.shells[h.shells.length - 1];
  p.emit(fixture("claude-2.1.318-bash.ansi"));
  await until(clock, () => h.feeds.get(s.id)!.card !== null);
  const seen = h.feeds.get(s.id)!.card!;
  p.writes.length = 0;
  // The live card is another prompt (an edit approval): the click was drawn on the bash card.
  p.emit(drawn("claude-2.1.318-edit"));
  await until(clock, () => h.feeds.get(s.id)!.card !== seen);
  assert.equal(await h.feeds.answer(s.id, "1", seen), false);
  assert.deepEqual(p.writes, []);
  assert.equal(await h.feeds.answer(s.id, "1", h.feeds.get(s.id)!.card!), true, "the live card is answered");
  assert.deepEqual(p.writes, ["1"]);
});

test("a dialog the chat can't draw (/model) is the waiting card, and Needs you", async () => {
  const clock = manualClock();
  const h = setup({ clock });
  const s = h.pool.create({ cols: 120, rows: 40, meta: { host: "claude", terminalKey: KEY } });
  await tick();
  h.shells[h.shells.length - 1].emit(drawn("claude-2.1.318-model"));
  await until(clock, () => h.feeds.get(s.id)!.card !== null);
  assert.deepEqual(h.feeds.get(s.id)!.card, { kind: "waiting" });
  assert.equal(h.feeds.get(s.id)!.needsYou, true);
  assert.equal(await h.feeds.answer(s.id, "1"), false, "a waiting card has no key to send");
});

test("a key is written only while its prompt is still on the screen and the agent runs (R39): a gone prompt, an unknown terminal or an ended agent write nothing", async () => {
  const clock = manualClock();
  const agentProc = proc();
  const h = setup({ clock, agent: async () => ({ ok: true, data: agentProc }) });
  const place: Place = { kind: "vault", label: "Vault", dir: h.vault };
  const spec: LaunchSpec = { host: "codex", bin: null, model: null, access: "edit", cwd: h.vault };
  const { session, ready } = h.pool.createAgent({ spec, place, meta: { host: "codex", place, terminalKey: KEY2 } });
  await ready;
  session.resize(120, 40);
  const feed = () => h.feeds.get(session.id)!;
  const title = () => { const c = feed().card; return c?.kind === "approval" ? c.title : null; };
  agentProc.emit(drawn("codex-0.167.0-bash"));
  await until(clock, () => feed().card !== null);
  assert.deepEqual(feed().card?.kind === "approval" ? feed().card : null, { kind: "approval", title: "Would you like to run the following command?", detail: "touch hi.txt", choices: [
    { key: "y", label: "Yes, proceed" },
    { key: "p", label: "Yes, and don't ask again for commands that start with `touch hi.txt`" },
    { key: "esc", label: "No, and tell Codex what to do differently" },
  ] });
  assert.equal(await h.feeds.answer("no-such-terminal", "y"), false);
  assert.equal(await h.feeds.answer(session.id, "a"), false, "a key this prompt does not offer");
  // Esc is the escape byte.
  assert.equal(await h.feeds.answer(session.id, "esc"), true);
  assert.deepEqual(agentProc.writes, ["\u001b"]);
  // The TUI's screen changed and the poll has not run yet: the card is stale, the click re-reads the screen.
  agentProc.emit(drawn("codex-0.167.0-edit"));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(title(), "Would you like to run the following command?", "not polled yet");
  assert.equal(await h.feeds.answer(session.id, "p"), false, "the prompt it answered is gone");
  assert.deepEqual(agentProc.writes, ["\u001b"]);
  clock.fire();
  assert.equal(title(), "Would you like to make the following edits?");
  // The agent ends and the login shell takes its terminal over: nothing on that screen is the agent's to answer.
  agentProc.exit(0);
  assert.equal(session.agentEnded, true);
  assert.equal(feed().card, null, "the card goes with the agent");
  assert.equal(feed().needsYou, false);
  assert.equal(h.feeds.screened(session.id), false, "its screen is let go");
  assert.equal(await h.feeds.answer(session.id, "y"), false);
  assert.deepEqual(agentProc.writes, ["\u001b"]);
  assert.deepEqual(h.shells[h.shells.length - 1].writes, [], "nothing reaches the shell");
});

test("a Codex terminal's status line is its footer rows copied from its screen, colours kept; the hint while an approval covers them (C5)", async () => {
  const clock = manualClock();
  const h = setup({ clock });
  const s = h.pool.create({ cols: 120, rows: 40, meta: { host: "codex", terminalKey: KEY2 } });
  await tick();
  const p = h.shells[h.shells.length - 1];
  const feed = () => h.feeds.get(s.id)!;
  assert.equal(feed().status, null);
  p.emit(fixture("codex-0.167.0-idle.ansi"));
  await until(clock, () => feed().status !== null);
  const st = feed().status!;
  const text = (spans: Array<{ text: string }>) => spans.map((x) => x.text).join("");
  assert.equal(st.length, 2);
  assert.equal(text(st[0]).trim(), "GPT-6-Luna low · Context 0% used · weekly limit ok");
  assert.match(st[0].find((x) => x.text === "GPT-6-Luna low")?.fg ?? "", /^rgb\(/, "its colours kept");
  assert.equal(feed().card, null);
  clock.fire();
  assert.equal(feed().status, st, "an unchanged footer is the same object (nothing to redraw)");
  p.emit(drawn("codex-0.167.0-bash"));
  await until(clock, () => feed().card !== null);
  assert.equal(feed().status, null, "covered by the approval: the composer's hint");
});

test("closing a terminal whose card was up lets its screen go and stops the poll; its feed says nothing more (the pool tells the badge)", async () => {
  const clock = manualClock();
  const h = setup({ clock });
  const s = h.pool.create({ cols: 120, rows: 40, meta: { host: "claude", terminalKey: KEY } });
  await tick();
  h.shells[h.shells.length - 1].emit(drawn("claude-2.1.318-model"));
  await until(clock, () => h.feeds.get(s.id)?.needsYou === true);
  assert.equal(clock.running, true, "a card up: polled");
  h.changed.length = 0;
  h.pool.remove(s.id);
  assert.equal(h.feeds.screened(s.id), false);
  assert.equal(clock.running, false, "nothing left to poll");
  // No notice from the feeds while the pool's own listeners still run (the panel records the closed row first).
  assert.deepEqual(h.changed, []);
  h.feeds.dispose();
});
