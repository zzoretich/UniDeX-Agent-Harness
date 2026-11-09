// The page's side of a Code launch's agent terminal (agent-computer D18): bridgeHost hands main's answer to the HUD as a
// terminal process, keeps output that arrives before the HUD listens, and turns a bridge that fails on the way into a
// fallback (the typed launch line), so the launch is never blocked by it. A fake window.aos stands in for the preload.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AosBridge, BootInfo, PtyAgentRequest, PtyEvent, Result } from "../../src/shared/ipc";
import { createBridgeHost } from "../../src/renderer/bridgeHost";
import type { HostPtyAgentRequest } from "../../../hud/src/host";

function fakeAos(answer: (req: PtyAgentRequest) => Promise<Result<{ pid: number }>>) {
  let emit: (ev: PtyEvent) => void = () => {};
  const asked: PtyAgentRequest[] = [];
  const killed: string[] = [];
  const aos = {
    pty: {
      onEvent: (cb: (ev: PtyEvent) => void) => { emit = cb; return () => {}; },
      spawnAgent: (req: PtyAgentRequest) => { asked.push(req); return answer(req); },
      kill: (id: string) => { killed.push(id); },
      write: () => {}, resize: () => {},
    },
  } as unknown as AosBridge;
  return { aos, asked, killed, emit: (ev: PtyEvent) => emit(ev) };
}

const INFO = { vaultRoot: "/vault", env: {}, home: "/home", platform: "darwin", writeSurfaces: [] } as unknown as BootInfo;
const REQ: HostPtyAgentRequest = {
  host: "claude", argv: ["--session-id", "3f2c9a1e"], cwd: "/vault", configDir: null, gitInit: false, cols: 80, rows: 24,
  place: "vault", label: "Claude Code in Vault", access: "edit",
};

test("an agent's terminal: main's pid, output that came before the HUD listened, its exit, and kill by the bridge's id", async () => {
  const f = fakeAos(async (req) => {
    // Main's first output races its answer.
    f.emit({ id: req.id, type: "data", data: "early " });
    return { ok: true, data: { pid: 4242 } };
  });
  const { host } = createBridgeHost(f.aos, INFO);
  const r = await host.pty.spawnAgent!(REQ);
  assert.ok(r.ok);
  assert.deepEqual(f.asked, [{ ...REQ, id: "t1" }], "the bridge names the terminal");
  assert.equal(r.data.pid, 4242);
  assert.equal(r.data.id, "t1", "the id the computer names the agent by (code:t1)");
  const seen: string[] = [];
  const exits: number[] = [];
  r.data.onData((d) => seen.push(d));
  f.emit({ id: "t1", type: "data", data: "late" });
  assert.deepEqual(seen, ["early ", "late"]);
  r.data.kill();
  assert.deepEqual(f.killed, ["t1"]);
  f.emit({ id: "t1", type: "exit", exitCode: 0 });
  r.data.onExit((e) => exits.push(e.exitCode));
  assert.deepEqual(exits, [0], "an exit before the listener is not lost");
});

test("main's fallback and refusals come back as they are; a bridge that fails on the way is a fallback", async () => {
  const fb = await createBridgeHost(fakeAos(async () => ({ ok: false, error: "Claude Code at /opt/claude isn't a supported install: unsigned", code: "fallback" })).aos, INFO).host.pty.spawnAgent!(REQ);
  assert.deepEqual(fb, { ok: false, error: "Claude Code at /opt/claude isn't a supported install: unsigned", code: "fallback" });
  const warn = console.warn;
  const warned: string[] = [];
  console.warn = (...a: unknown[]) => { warned.push(a.join(" ")); };
  let no: Result<unknown>;
  try { no = await createBridgeHost(fakeAos(async () => ({ ok: false, error: "Claude Code with the flag --mcp-config", code: "EROFS" })).aos, INFO).host.pty.spawnAgent!(REQ); }
  finally { console.warn = warn; }
  assert.deepEqual(no, { ok: false, error: "Claude Code with the flag --mcp-config", code: "EROFS" });
  const log = (globalThis as { __aosGuard?: { log: Array<{ kind: string; what: string }> } }).__aosGuard?.log ?? [];
  assert.deepEqual(log.map((e) => [e.kind, e.what]), [["spawn", "claude --session-id 3f2c9a1e"]], "a refusal is in the guard log");
  assert.equal(warned.length, 1);
  const broke = await createBridgeHost(fakeAos(async () => { throw new Error("reply was never sent"); }).aos, INFO).host.pty.spawnAgent!(REQ);
  assert.deepEqual(broke, { ok: false, error: "reply was never sent", code: "fallback" });
});

test("the Computer pane's host says whether the computer surface is on for this run (agent-computer D26, ruling R54)", () => {
  const on = (writeSurfaces: string[]) => createBridgeHost(fakeAos(async () => ({ ok: true, data: { pid: 1 } })).aos, { ...INFO, writeSurfaces } as BootInfo).host.computer?.enabled;
  assert.equal(on([]), false);
  assert.equal(on(["sessions", "todo"]), false);
  assert.equal(on(["sessions", "computer"]), true);
});

test("the Computer pane's host carries main's start page, fixed at boot (DuckDuckGo, or the e2e suite's fixture in its runs)", () => {
  const start = (computerStartPage?: string) => createBridgeHost(fakeAos(async () => ({ ok: true, data: { pid: 1 } })).aos, { ...INFO, ...(computerStartPage === undefined ? {} : { computerStartPage }) } as BootInfo).host.computer?.startPage;
  assert.equal(start("https://duckduckgo.com/"), "https://duckduckgo.com/");
  assert.equal(start("http://search.test:4100/"), "http://search.test:4100/");
  assert.equal(start(), undefined, "a boot without one leaves the HUD's own copy in charge");
});
