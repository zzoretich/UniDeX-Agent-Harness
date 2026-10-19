import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resolveNodeBinary, nodeCandidates, resetProbeForTests, NodeResolverDeps } from "./nodeResolver";
import type { AgenticOSSettings } from "../settingsDefaults";

function settings(nodePath = ""): AgenticOSSettings {
  return { nodePath } as AgenticOSSettings;
}

function deps(over: Partial<NodeResolverDeps> & { existing?: string[]; nvm?: string[] } = {}): NodeResolverDeps {
  // Pull the test-only keys and any probe stub out first, then spread the remaining overrides
  // BEFORE the recording execFileSync: a test's own execFileSync must never replace the recorder
  // (the recorder delegates to it), and `existing`/`nvm` must not land on the deps object.
  const { existing = [], nvm, execFileSync: probe, ...rest } = over;
  const have = new Set(existing);
  const calls: string[][] = [];
  const d: NodeResolverDeps = {
    existsSync: (p) => have.has(p),
    readdirSync: (p) => { if (p === "/home/alice/.nvm/versions/node") return nvm ?? []; throw new Error("ENOENT"); },
    homedir: () => "/home/alice",
    platform: "linux",
    env: { SHELL: "/bin/zsh" },
    agenticosNode: () => null,
    ...rest,
    execFileSync: (file, args, opts) => { calls.push([file, ...args]); return probe ? probe(file, args, opts) : ""; },
  };
  (d as NodeResolverDeps & { calls: string[][] }).calls = calls;
  return d;
}

beforeEach(() => resetProbeForTests());

test("settings.nodePath wins when it exists on disk", () => {
  const d = deps({ existing: ["/custom/node", "/usr/bin/node"], agenticosNode: () => "/usr/bin/node" });
  assert.equal(resolveNodeBinary(settings("/custom/node"), d), "/custom/node");
});

test("a stale settings.nodePath is skipped and agenticos.json.node is used", () => {
  const d = deps({ existing: ["/usr/bin/node"], agenticosNode: () => "/usr/bin/node" });
  assert.equal(resolveNodeBinary(settings("/gone/node"), d), "/usr/bin/node");
});

test("candidates include nvm (newest first), volta and fnm after the platform list", () => {
  // v9.0.0 is here so the numeric comparator is exercised: a lexicographic sort would rank "v9" above "v22" (Ruling A19).
  const list = nodeCandidates(deps({ nvm: ["v9.0.0", "v20.11.0", "v22.3.0"] }));
  assert.deepEqual(list, [
    "/usr/local/bin/node", "/usr/bin/node", "/snap/bin/node",
    "/home/alice/.nvm/versions/node/v22.3.0/bin/node",
    "/home/alice/.nvm/versions/node/v20.11.0/bin/node",
    "/home/alice/.nvm/versions/node/v9.0.0/bin/node",
    "/home/alice/.volta/bin/node",
    "/home/alice/.local/share/fnm/aliases/default/bin/node",
  ]);
});

test("the first existing candidate is returned without probing the shell", () => {
  const d = deps({ existing: ["/home/alice/.volta/bin/node"] });
  assert.equal(resolveNodeBinary(settings(), d), "/home/alice/.volta/bin/node");
  assert.equal((d as NodeResolverDeps & { calls: string[][] }).calls.length, 0);
});

test("the login-shell probe runs once, saves its result into settings, and later calls reuse it", () => {
  const s = settings();
  const d = deps({ existing: ["/opt/nvm/current/bin/node"], execFileSync: () => "/opt/nvm/current/bin/node\n" });
  assert.equal(resolveNodeBinary(s, d), "/opt/nvm/current/bin/node");
  assert.equal(s.nodePath, "/opt/nvm/current/bin/node");
  const calls = (d as NodeResolverDeps & { calls: string[][] }).calls;
  assert.deepEqual(calls, [["/bin/zsh", "-lic", "command -v node"]]);
  assert.equal(resolveNodeBinary(s, d), "/opt/nvm/current/bin/node");
  assert.equal(calls.length, 1);
});

test("with nothing found the resolver falls back to the bare name and does not probe twice", () => {
  const d = deps({ execFileSync: () => { throw new Error("no shell"); } });
  assert.equal(resolveNodeBinary(settings(), d), "node");
  assert.equal(resolveNodeBinary(settings(), d), "node");
  assert.equal((d as NodeResolverDeps & { calls: string[][] }).calls.length, 1);
});

