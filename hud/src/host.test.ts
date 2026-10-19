import { test } from "node:test";
import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fs, hudHost, sessionsHost, setHudHost, spawn, utf8, utf8Bytes, type HudHost } from "./host";
import { createNodeHost } from "./nodeHost";

const ROOT = path.resolve(__dirname, "..");

function sources(): string[] {
  const out = [path.join(ROOT, "main.ts")];
  const walk = (dir: string): void => {
    for (const e of nodeFs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(p);
    }
  };
  walk(path.join(ROOT, "src"));
  return out;
}

// The seam holds only if nothing goes around it: in the app the page has no Node, so a module that imports `fs` or
// reads `process.env` itself fails there (the app's build refuses such an import too, scripts/build.mjs).
test("only nodeHost.ts reaches Node's I/O, node-pty, electron, require, process or Buffer", () => {
  const forbidden: Array<[RegExp, string]> = [
    [/from\s+["'](node:)?(fs|fs\/promises|child_process|os|net|http|https|electron|node-pty)["']/, "imports a Node I/O module"],
    [/\brequire\s*\(/, "calls require()"],
    [/\bprocess\.(env|platform|cwd|versions|execPath|argv|exit|kill|pid)\b/, "reads process"],
    [/\bBuffer\.|\bnew Buffer\b|:\s*Buffer\b/, "uses Buffer"],
    [/\b(setImmediate|clearImmediate|__dirname|__filename)\b/, "uses a Node-only global"],
  ];
  const hits: string[] = [];
  for (const file of sources()) {
    const rel = path.relative(ROOT, file);
    if (rel === path.join("src", "nodeHost.ts")) continue;
    nodeFs.readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      for (const [re, why] of forbidden) if (re.test(line)) hits.push(`${rel}:${i + 1} ${why}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, []);
});

test("the Node host is the default, and setHudHost replaces it for every module", () => {
  const node = hudHost();
  assert.equal(typeof node.fs.readFileSync, "function");
  const calls: string[] = [];
  const fake = { ...createNodeHost(), fs: { ...createNodeHost().fs, existsSync: (p: string) => { calls.push(p); return true; } } } as HudHost;
  setHudHost(fake);
  try {
    assert.equal(fs.existsSync("/no/such/file"), true);
    assert.deepEqual(calls, ["/no/such/file"]);
  } finally {
    setHudHost(node);
  }
  assert.equal(fs.existsSync("/no/such/file"), false);
});

test("agent sessions are the app's alone: the Node host has none, and a host with both offers them", () => {
  const node = hudHost();
  assert.equal(sessionsHost(), null);
  const sessions = { start: async () => ({ ok: false as const, error: "x", code: "EROFS" }) } as unknown as NonNullable<HudHost["sessions"]>;
  const git = {} as NonNullable<HudHost["git"]>;
  setHudHost({ ...createNodeHost(), sessions, git });
  try {
    assert.equal(sessionsHost()?.sessions, sessions);
    setHudHost({ ...createNodeHost(), sessions });
    assert.equal(sessionsHost(), null, "sessions without git is not offered");
  } finally {
    setHudHost(node);
  }
});

test("readBytesSync reads a byte range, fewer at the end, none past it", () => {
  const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "aos-host-"));
  const file = path.join(dir, "log.jsonl");
  nodeFs.writeFileSync(file, "héllo\nworld\n");
  assert.equal(utf8(fs.readBytesSync(file, 0, 6)), "héllo");
  assert.equal(utf8(fs.readBytesSync(file, 7, 100)), "world\n");
  assert.equal(fs.readBytesSync(file, 50, 10).length, 0);
  assert.equal(utf8Bytes("é").length, 2);
  nodeFs.rmSync(dir, { recursive: true, force: true });
});

test("spawn sets and unsets variables on top of the host's environment and streams text", async () => {
  process.env.AOS_HOST_TEST_KEEP = "kept";
  process.env.AOS_HOST_TEST_DROP = "dropped";
  try {
    const child = spawn(process.execPath, ["-e", "process.stdout.write(JSON.stringify([process.env.AOS_HOST_TEST_KEEP, process.env.AOS_HOST_TEST_SET, process.env.AOS_HOST_TEST_DROP ?? null]))"],
      { env: { AOS_HOST_TEST_SET: "set" }, unsetEnv: ["AOS_HOST_TEST_DROP"] });
    let out = "";
    const kinds = new Set<string>();
    child.stdout?.on("data", (d) => { kinds.add(typeof d); out += d; });
    const code = await new Promise<number | null>((resolve) => child.on("close", (c) => resolve(c)));
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(out), ["kept", "set", null]);
    assert.deepEqual([...kinds], ["string"]);
  } finally {
    delete process.env.AOS_HOST_TEST_KEEP;
    delete process.env.AOS_HOST_TEST_DROP;
  }
});
