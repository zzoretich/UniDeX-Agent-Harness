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
const { CodeFeeds, EVENT_CAP, ROW_CAP } = require("./codeFeeds") as typeof FeedsModule;

const KEY = "aaaaaaaa-0000-4000-8000-000000000001";
const SID = "cccccccc-0000-4000-8000-000000000003";

type Proc = HostPtyProcess & { exit(code?: number): void };
let nextPty = 0;
function proc(): Proc {
  const exit: Array<(e: { exitCode: number }) => void> = [];
  return {
    pid: 1000 + nextPty, id: `t${++nextPty}`,
    write: () => {}, resize: () => {}, kill: () => {},
    onData: () => {}, onExit: (cb) => { exit.push(cb); },
    exit: (code = 0) => { for (const cb of exit) cb({ exitCode: code }); },
  };
}

interface Follow { pty: string; host: string; terminal: string; id?: string | null }
/** A host whose terminals and follower are fakes over a temp vault; `answer` is main's reply to follow. */
function setup(o: { code?: boolean; answer?: (r: Follow) => HostResult<{ cache: string; fresh: boolean }>; agent?: () => Promise<HostPtyAgentResult> } = {}) {
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
  const feeds = new CodeFeeds(pool, { vaultRoot: () => vault });
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
