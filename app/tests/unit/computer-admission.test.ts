import { test } from "node:test";
import assert from "node:assert/strict";
import { admit, installForm, launchForm, VENDOR, type Sys } from "../../src/main/computer/admission";
import { AgentRegistry, type AgentRef } from "../../src/main/computer/registry";
import type { ProcInfo } from "../../src/main/computer/peer";

// A fake process table: pid -> info, code-signing team of the running process, and the static team of a path.
const SERVER = "/vault/brain/scripts/sdk/mcp-server.js";
const NOT_STARTED = "Not started by UniDeX: start this session from the Code page's New menu or a Chat thread.";
const ALREADY_OPEN = "This session's computer connection is already open.";
const CLAUDE = VENDOR.claude.team;
const CODEX = VENDOR.codex.team;

interface World {
  procs: ProcInfo[];
  running?: Record<number, string | null>;
  files?: Record<string, string | null>;
  links?: Record<string, string>;
  missing?: string[];
}
function fake(w: World): Sys & { teamCalls: number } {
  const sys = {
    teamCalls: 0,
    procInfo: (pid: number) => w.procs.find((p) => p.pid === pid) ?? null,
    processTeamId: (pid: number) => w.running?.[pid] ?? null,
    teamId(p: string) { sys.teamCalls++; return w.files?.[p] ?? null; },
    realpath(p: string) {
      if (w.missing?.includes(p)) throw new Error("ENOENT");
      return w.links?.[p] ?? p;
    },
    stat: () => ({ ino: 1, size: 2, mtimeMs: 3 }),
  };
  return sys;
}
const proc = (pid: number, ppid: number, p: string, argv: string[] = [p]): ProcInfo => ({ pid, ppid, path: p, argv });
const server = (pid: number, ppid: number, script = SERVER) => proc(pid, ppid, "/usr/bin/node", ["node", script]);
const agent = (pid: number, host: "claude" | "codex" = "claude"): AgentRef => ({ pid, host, page: "code", key: `code:${pid}`, label: "t", place: "/w", access: "edit" });
function run(w: World, peer: number, regs: AgentRef[], trusted?: string[]) {
  const reg = new AgentRegistry();
  for (const a of regs) reg.add(a);
  return admit(peer, { reg, sys: fake(w), server: SERVER, trusted });
}
const NPM_CLAUDE = `/usr/lib/node_modules/${VENDOR.claude.pkg}/cli.js`;
const NPM_CODEX = `/usr/lib/node_modules/${VENDOR.codex.pkg}/bin/codex.js`;

test("admitted: native Claude, Homebrew Codex, npm Claude", () => {
  const cases: Array<[string, World, AgentRef]> = [
    ["native claude", { procs: [server(20, 10), proc(10, 1, "/opt/claude")], running: { 10: CLAUDE } }, agent(10)],
    ["homebrew codex", { procs: [server(20, 10), proc(10, 1, "/opt/homebrew/bin/codex")], running: { 10: CODEX } }, agent(10, "codex")],
    ["npm claude", { procs: [server(20, 10), proc(10, 1, "/usr/local/bin/node", ["node", "/usr/local/bin/claude"])], links: { "/usr/local/bin/claude": NPM_CLAUDE } }, agent(10)],
  ];
  for (const [name, w, a] of cases) {
    const r = run(w, 20, [a]);
    assert.deepEqual(r, { ok: true, agent: a }, name);
  }
});

test("admitted: npm Codex shim, then native codex, then the server", () => {
  const w: World = {
    procs: [server(30, 20), proc(20, 10, "/pkg/vendor/codex"), proc(10, 1, "/usr/local/bin/node", ["node", "/usr/local/bin/codex"])],
    running: { 20: CODEX },
    links: { "/usr/local/bin/codex": NPM_CODEX },
  };
  const a = agent(10, "codex");
  assert.deepEqual(run(w, 30, [a]), { ok: true, agent: a });
});

test("admitted: the server script may be reached through a link", () => {
  const w: World = { procs: [server(20, 10, "/link/mcp-server.js"), proc(10, 1, "/opt/claude")], running: { 10: CLAUDE }, links: { "/link/mcp-server.js": SERVER } };
  assert.equal(run(w, 20, [agent(10)]).ok, true);
});

test("refused: every case outside the admitted forms", () => {
  const cases: Array<[string, World, AgentRef[]]> = [
    ["a node script under a shell under the CLI", { procs: [proc(30, 20, "/usr/bin/node", ["node", "build.js"]), proc(20, 15, "/bin/zsh"), proc(15, 10, "/opt/claude"), proc(10, 1, "/x")], running: { 15: CLAUDE } }, [agent(15)]],
    ["an agent Bash running the server under a shell", { procs: [server(30, 20), proc(20, 15, "/bin/zsh"), proc(15, 1, "/opt/claude")], running: { 15: CLAUDE } }, [agent(15)]],
    ["a parent outside the app", { procs: [server(20, 10), proc(10, 1, "/opt/claude")], running: { 10: CLAUDE } }, []],
    ["an unregistered process with forged claude argv", { procs: [server(20, 10), proc(10, 1, "/tmp/evil", ["claude"])], running: {} }, [agent(99)]],
    ["a wrong server path", { procs: [server(20, 10, "/tmp/other.js"), proc(10, 1, "/opt/claude")], running: { 10: CLAUDE } }, [agent(10)]],
    ["a CLI signed by another team", { procs: [server(20, 10), proc(10, 1, "/opt/claude")], running: { 10: "OTHERTEAM1" } }, [agent(10)]],
    ["a Claude CLI that is Codex-signed", { procs: [server(20, 10), proc(10, 1, "/opt/claude")], running: { 10: CODEX } }, [agent(10)]],
    ["a swapped binary (static team matches, running code does not)", { procs: [server(20, 10), proc(10, 1, "/opt/claude")], running: { 10: null }, files: { "/opt/claude": CLAUDE } }, [agent(10)]],
    ["a missing realpath for the CLI", { procs: [server(20, 10), proc(10, 1, "/opt/claude")], running: { 10: CLAUDE }, missing: ["/opt/claude"] }, [agent(10)]],
    ["a missing realpath for the server script", { procs: [server(20, 10), proc(10, 1, "/opt/claude")], running: { 10: CLAUDE }, missing: [SERVER] }, [agent(10)]],
    ["a gone peer", { procs: [proc(10, 1, "/opt/claude")], running: { 10: CLAUDE } }, [agent(10)]],
    ["a gone parent", { procs: [server(20, 10)] }, [agent(10)]],
    ["a shim whose grandparent is not npm", { procs: [server(30, 20), proc(20, 10, "/pkg/codex"), proc(10, 1, "/opt/other")], running: { 20: CODEX } }, [agent(10, "codex")]],
    ["a shim whose child is not Codex-signed", { procs: [server(30, 20), proc(20, 10, "/pkg/codex"), proc(10, 1, "/usr/local/bin/node", ["node", "c.js"])], running: { 20: CLAUDE }, links: { "c.js": NPM_CODEX } }, [agent(10, "codex")]],
    ["an npm Claude shim (the shim path is Codex only)", { procs: [server(30, 20), proc(20, 10, "/pkg/claude"), proc(10, 1, "/usr/local/bin/node", ["node", "c.js"])], running: { 20: CLAUDE }, links: { "c.js": NPM_CLAUDE } }, [agent(10, "claude")]],
    ["npm form with the wrong package", { procs: [server(20, 10), proc(10, 1, "/usr/bin/node", ["node", "/usr/lib/node_modules/left-pad/index.js"])] }, [agent(10)]],
    ["npm form not run by node", { procs: [server(20, 10), proc(10, 1, "/usr/bin/python", ["python", NPM_CLAUDE])] }, [agent(10)]],
  ];
  // the peer is the first process listed, except where the case is a peer that is gone (pid 20 is not listed)
  for (const [name, w, regs] of cases) {
    const peer = name === "a gone peer" ? 20 : w.procs[0].pid;
    assert.deepEqual(run(w, peer, regs), { ok: false, reason: NOT_STARTED }, name);
  }
});

test("a second connection under one CLI is refused, and a removed agent frees the claim", () => {
  const w: World = { procs: [server(20, 10), server(21, 10), proc(10, 1, "/opt/claude")], running: { 10: CLAUDE } };
  const reg = new AgentRegistry();
  reg.add(agent(10));
  const sys = fake(w);
  assert.equal(admit(20, { reg, sys, server: SERVER }).ok, true);
  assert.deepEqual(admit(21, { reg, sys, server: SERVER }), { ok: false, reason: ALREADY_OPEN });
  reg.remove(10);
  assert.deepEqual(admit(21, { reg, sys, server: SERVER }), { ok: false, reason: NOT_STARTED });
  reg.add(agent(10));
  assert.equal(admit(21, { reg, sys, server: SERVER }).ok, true);
});

test("registry: get, claim once per registration, unknown pids", () => {
  const reg = new AgentRegistry();
  assert.equal(reg.get(1), undefined);
  assert.equal(reg.claim(1), false);
  reg.add(agent(1));
  assert.equal(reg.get(1)?.key, "code:1");
  assert.equal(reg.claim(1), true);
  assert.equal(reg.claim(1), false);
  reg.remove(1);
  assert.equal(reg.get(1), undefined);
});

test("trusted realpaths count as native in admission and installForm", () => {
  const w: World = { procs: [server(20, 10), proc(10, 1, "/build/fake-claude")], running: {}, links: { "/build/fake-claude": "/real/fake-claude" } };
  assert.equal(run(w, 20, [agent(10)]).ok, false);
  assert.equal(run(w, 20, [agent(10)], ["/real/fake-claude"]).ok, true);
  assert.equal(installForm("claude", proc(10, 1, "/build/fake-claude"), fake(w), ["/real/fake-claude"]), "native");
  assert.equal(installForm("claude", proc(10, 1, "/build/fake-claude"), fake(w)), null);
});

test("installForm: a missing realpath is null, not a throw", () => {
  const w: World = { procs: [], running: { 10: CLAUDE }, missing: ["/gone"] };
  assert.equal(installForm("claude", proc(10, 1, "/gone"), fake(w)), null);
});

test("launchForm: native signature, npm script, unsigned refused, wrong team refused", () => {
  const w: World = {
    procs: [],
    files: { "/opt/claude": CLAUDE, "/opt/codex": CODEX, "/opt/unsigned": null, "/opt/crossed": CODEX },
    links: { "/bin/claude-npm": NPM_CLAUDE },
    missing: ["/gone"],
  };
  const sys = fake(w);
  assert.equal(launchForm("claude", "/opt/claude", sys), "native");
  assert.equal(launchForm("codex", "/opt/codex", sys), "native");
  assert.equal(launchForm("claude", "/bin/claude-npm", sys), "npm");
  assert.equal(launchForm("codex", "/bin/claude-npm", sys), null);
  assert.equal(launchForm("claude", "/opt/unsigned", sys), null);
  assert.equal(launchForm("claude", "/opt/crossed", sys), null);
  assert.equal(launchForm("claude", "/gone", sys), null);
});

test("launchForm: trusted counts as native", () => {
  const sys = fake({ procs: [], links: { "/b/fake": "/real/fake" } });
  assert.equal(launchForm("codex", "/b/fake", sys), null);
  assert.equal(launchForm("codex", "/b/fake", sys, ["/real/fake"]), "native");
});

test("launchForm: the static check is cached per file identity", () => {
  let mtime = 1;
  const sys = fake({ procs: [], files: { "/opt/cached": CLAUDE } });
  sys.stat = () => ({ ino: 7, size: 9, mtimeMs: mtime });
  assert.equal(launchForm("claude", "/opt/cached", sys), "native");
  assert.equal(launchForm("claude", "/opt/cached", sys), "native");
  assert.equal(sys.teamCalls, 1);
  mtime = 2;
  assert.equal(launchForm("claude", "/opt/cached", sys), "native");
  assert.equal(sys.teamCalls, 2);
});
