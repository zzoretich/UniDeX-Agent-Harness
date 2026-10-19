import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runAos, runAosJson, failureText, needsUpgrade, listFailure, aosEnv, AOS_CLI } from "./aosRun";

/** A fixture CLI: echoes its argv and the pinned env as JSON, or misbehaves on request. */
function fixture(): { vault: string; configDir: string; cli: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "aos-run-"));
  const vault = path.join(base, "vault");
  const configDir = path.join(base, "cfg");
  fs.mkdirSync(path.join(vault, "brain", "scripts", "cli"), { recursive: true });
  fs.mkdirSync(configDir);
  const cli = path.join(vault, AOS_CLI);
  fs.writeFileSync(cli, `
const a = process.argv.slice(2);
if (a[0] === "bad") { process.stderr.write("aos config: ollama.port must be at most 65535\\n"); process.exit(2); }
if (a[0] === "usage") { process.stderr.write("aos: unknown command: config\\nusage:\\n  aos init\\n"); process.exit(2); }
if (a[0] === "notjson") { process.stdout.write("not json"); process.exit(0); }
if (a[0] === "hang") { setInterval(() => {}, 1000); }
else process.stdout.write(JSON.stringify({ argv: a, vault: process.env.AOS_VAULT, config: process.env.AOS_CONFIG, cwd: process.cwd() }));
`);
  return { vault, configDir, cli };
}

test("runAos spawns the vendored CLI with AOS_VAULT/AOS_CONFIG pinned, in the vault, and waits for its output", async () => {
  const f = fixture();
  const r = await runAosJson<{ argv: string[]; vault: string; config: string; cwd: string }>(["config", "list", "--json"], { node: process.execPath, vault: f.vault, configDir: f.configDir });
  assert.equal(r.code, 0);
  assert.deepEqual(r.json?.argv, ["config", "list", "--json"]);
  assert.equal(r.json?.vault, f.vault);
  assert.equal(r.json?.config, path.join(f.configDir, "agenticos.json"));
  assert.equal(fs.realpathSync(r.json!.cwd), fs.realpathSync(f.vault));
});

test("a refused value: exit 2, the CLI's own message, no json", async () => {
  const f = fixture();
  const r = await runAosJson(["bad"], { node: process.execPath, vault: f.vault, configDir: f.configDir });
  assert.equal(r.code, 2);
  assert.equal(r.json, null);
  assert.equal(failureText(r), "ollama.port must be at most 65535");
  assert.equal(needsUpgrade(r), false);
});

test("an older runtime without `aos config` asks for an upgrade (D13); so does a missing CLI", async () => {
  const f = fixture();
  const r = await runAos(["usage"], { node: process.execPath, vault: f.vault, configDir: f.configDir });
  assert.equal(needsUpgrade(r), true);
  assert.equal(failureText(r), "unknown command: config");
  const gone = await runAos(["x"], { node: process.execPath, vault: f.vault, configDir: f.configDir, cli: path.join(f.vault, "nope.js") });
  assert.notEqual(gone.code, 0);
  assert.equal(needsUpgrade(gone), true);
});

test("an unparseable body is a parse error, not a crash", async () => {
  const f = fixture();
  const r = await runAosJson(["notjson"], { node: process.execPath, vault: f.vault, configDir: f.configDir });
  assert.equal(r.code, 0);
  assert.equal(r.json, null);
  assert.match(r.parseError ?? "", /JSON/);
});

test("a hung child is killed after the timeout", async () => {
  const f = fixture();
  const r = await runAos(["hang"], { node: process.execPath, vault: f.vault, configDir: f.configDir, timeoutMs: 300 });
  assert.equal(r.timedOut, true);
  assert.equal(r.code, -1);
  assert.equal(failureText(r), "aos did not answer in time");
});

test("a node binary that cannot start resolves with the spawn error", async () => {
  const f = fixture();
  const r = await runAos(["config"], { node: path.join(f.vault, "no-such-node"), vault: f.vault, configDir: f.configDir });
  assert.equal(r.code, -1);
  assert.match(failureText(r), /^could not run aos: /);
});

test("aosEnv keeps the base environment and overrides only the two pins", () => {
  const env = aosEnv({ node: "n", vault: "/v", configDir: "/c", env: { PATH: "/bin", AOS_VAULT: "/old" } });
  assert.deepEqual(env, { PATH: "/bin", AOS_VAULT: "/v", AOS_CONFIG: path.join("/c", "agenticos.json") });
});

test("listFailure: only a missing verb or CLI asks for an upgrade; unreadable output says what it is", () => {
  const base = { stdout: "", stderr: "", timedOut: false, json: null };
  assert.equal(listFailure({ ...base, code: 0, json: {} }, true), null);
  assert.deepEqual(listFailure({ ...base, code: 2, stderr: "aos: unknown command: config\nusage:" }, false), { text: "unknown command: config", upgrade: true });
  assert.deepEqual(listFailure({ ...base, code: 1, stderr: "aos: boom\n" }, false), { text: "boom", upgrade: false });
  assert.deepEqual(listFailure({ ...base, code: 0, parseError: "Unexpected end of JSON input" }, false),
    { text: "aos config list sent output that does not parse (Unexpected end of JSON input)", upgrade: false });
  assert.deepEqual(listFailure({ ...base, code: 0, json: { schema: 2 } }, false), { text: "aos config list answered in an unexpected shape", upgrade: false });
});
