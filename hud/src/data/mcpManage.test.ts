import { test } from "node:test";
import assert from "node:assert/strict";
import { addArgs, addConfirm, addPlanFor, checkAdd, hostArgs, hostConfirm, hostPlanFor, splitCommand, terminalLine, type AddForm } from "./mcpManage";

const H = "0f".repeat(32);

test("hostArgs: the dry run, or the real run with the dry run's hash; nothing the surface would refuse", () => {
  assert.deepEqual(hostArgs("park", "docs-search", "claude", true), ["mcp", "park", "docs-search", "--host", "claude", "--dry-run", "--json"]);
  assert.deepEqual(hostArgs("unpark", "x", "codex", false, H), ["mcp", "unpark", "x", "--host", "codex", "--expect", H, "--json"]);
  assert.throws(() => hostArgs("remove", "web fetch", "claude", true), /not a server name/);
  assert.throws(() => hostArgs("park", "x", "cursor" as never, true), /not a host/);
  assert.throws(() => hostArgs("park", "x", "claude", false), /needs the dry run's hash/);
  assert.throws(() => hostArgs("copy" as never, "x", "claude", true), /not a verb/);
});

test("addArgs: --command with each --arg and --env KEY=$VAR, or --url with --bearer-env $VAR, in one order; terminalLine quotes the $", () => {
  const local = { name: "gh", to: "both" as const, kind: "local" as const, command: "npx", args: ["-y", "gh-mcp"], url: "", bearer: null, env: [{ key: "GITHUB_TOKEN", var: "GH" }] };
  const a = addArgs(local, true);
  assert.deepEqual(a, ["mcp", "add", "gh", "--to", "both", "--command", "npx", "--arg", "-y", "--arg", "gh-mcp", "--env", "GITHUB_TOKEN=$GH", "--dry-run", "--json"]);
  assert.equal(terminalLine(a), "aos mcp add gh --to both --command npx --arg -y --arg gh-mcp --env 'GITHUB_TOKEN=$GH'");
  const remote = { ...local, to: "codex" as const, kind: "remote" as const, command: "", args: [], url: "https://charts.example.com/mcp", bearer: "CHARTS_TOKEN", env: [] };
  assert.deepEqual(addArgs(remote, false, H), ["mcp", "add", "gh", "--to", "codex", "--url", "https://charts.example.com/mcp", "--bearer-env", "$CHARTS_TOKEN", "--expect", H, "--json"]);
  assert.equal(terminalLine(addArgs(remote, false, H)), "aos mcp add gh --to codex --url https://charts.example.com/mcp --bearer-env '$CHARTS_TOKEN'");
  assert.equal(terminalLine(hostArgs("park", "x", "codex", true)), "aos mcp park x --host codex");
  assert.throws(() => addArgs(local, false), /needs the dry run's hash/);
});

const PARK = { ok: true, dryRun: true, verb: "park", name: "docs", host: "claude", transport: "stdio", command: "claude mcp remove docs --scope user", file: "~/.claude.json", backup: "~/.local/share/unidex/backups/mcp/claude-claude.json-x.bak", stash: "~/.local/share/unidex/parked/mcp/claude-docs.json", expect: H };

test("hostPlanFor: only the dry run of this verb, server and host is a plan; the confirm shows the command, file, backup and stash", () => {
  const p = hostPlanFor(PARK, "park", "docs", "claude", true)!;
  assert.equal(p.command, "claude mcp remove docs --scope user");
  for (const [verb, name, h, dry] of [["unpark", "docs", "claude", true], ["park", "other", "claude", true], ["park", "docs", "codex", true], ["park", "docs", "claude", false]] as const) {
    assert.equal(hostPlanFor(PARK, verb, name, h, dry), null, `${verb} ${name} ${h} ${dry}`);
  }
  assert.equal(hostPlanFor({ ...PARK, expect: "abc" }, "park", "docs", "claude"), null);
  const c = hostConfirm(p);
  assert.equal(c.title, "Park docs?");
  assert.equal(c.message, "Removes it from Claude Code and keeps its exact settings in a private stash outside the vault; Turn on puts it back unchanged.");
  assert.equal(c.detail, "Writes ~/.claude.json\nBacks it up first to ~/.local/share/unidex/backups/mcp/claude-claude.json-x.bak\nKeeps its exact entry in ~/.local/share/unidex/parked/mcp/claude-docs.json\n\nclaude mcp remove docs --scope user");
  assert.deepEqual([c.confirm, c.danger], ["Park", false]);
  const rm = hostConfirm({ ...p, verb: "remove", stash: null, command: "claude mcp remove docs --scope user" });
  assert.deepEqual([rm.title, rm.confirm, rm.danger], ["Remove docs from Claude Code?", "Remove", true]);
  const on = hostConfirm(hostPlanFor({ ...PARK, verb: "unpark", host: "codex", command: "codex mcp add docs -- docs-mcp", paste: 'env_vars = ["TOKEN"]', pasteUnder: "[mcp_servers.docs]", pasteFile: "~/.codex/config.toml", pasteNote: "Codex passes each of these to the server from its own environment, by that name" }, "unpark", "docs", "codex")!);
  assert.equal(on.title, "Turn docs back on?");
  assert.match(on.detail, /Then paste under \[mcp_servers\.docs\] in ~\/\.codex\/config\.toml:\n {2}env_vars = \["TOKEN"\]$/);
});

const ADD = {
  ok: true, dryRun: true, verb: "add", name: "gh", to: "both", transport: "stdio", secrets: ["GITHUB_TOKEN ← $GH"], expect: H,
  hosts: [
    { host: "claude", command: "claude mcp add-json --scope user gh '{…}'", file: "~/.claude.json", backup: null },
    { host: "codex", command: "codex mcp add gh -- npx -y gh-mcp", file: "~/.codex/config.toml", backup: "~/b.bak", paste: 'env_vars = ["GITHUB_TOKEN"]', pasteUnder: "[mcp_servers.gh]", pasteFile: "~/.codex/config.toml", pasteNote: "Codex passes each of these to the server from its own environment, by that name: set GITHUB_TOKEN from $GH where Codex starts" },
  ],
};

test("addPlanFor: the hosts asked, in order; the confirm lists each host's command and Codex's env_vars line (A1)", () => {
  const p = addPlanFor(ADD, "gh", "both", true)!;
  assert.deepEqual(p.hosts.map((h) => h.host), ["claude", "codex"]);
  assert.equal(addPlanFor(ADD, "gh", "codex", true), null, "a plan for other hosts is not this one");
  assert.equal(addPlanFor({ ...ADD, hosts: [ADD.hosts[1], ADD.hosts[0]] }, "gh", "both"), null);
  const c = addConfirm(p);
  assert.equal(c.title, "Add gh to Claude Code and Codex?");
  assert.equal(c.confirm, "Add to both");
  assert.match(c.message, /Secrets go by name only \(GITHUB_TOKEN ← \$GH\)/);
  assert.match(c.message, /set GITHUB_TOKEN from \$GH where Codex starts: `codex mcp add` takes values only/);
  assert.equal(c.detail, [
    "Claude Code: writes ~/.claude.json", "  no backup: the file does not exist yet", "claude mcp add-json --scope user gh '{…}'", "",
    "Codex: writes ~/.codex/config.toml", "  backs it up first to ~/b.bak", "codex mcp add gh -- npx -y gh-mcp",
    "Then paste under [mcp_servers.gh] in ~/.codex/config.toml:", '  env_vars = ["GITHUB_TOKEN"]',
  ].join("\n"));
  assert.equal(addConfirm(addPlanFor({ ...ADD, to: "claude", hosts: [ADD.hosts[0]] }, "gh", "claude")!).confirm, "Add to Claude Code");
});

test("checkAdd: a name both CLIs take, an enabled host, a command or a URL, and secrets as variables' names, never a value", () => {
  const f = (o: Partial<AddForm>): AddForm => ({ name: "gh", kind: "local", command: "npx -y 'gh mcp'", url: "", secrets: [{ key: "GITHUB_TOKEN", var: "$GH" }], hosts: ["claude", "codex"], ...o });
  const ok = checkAdd(f({}), ["claude", "codex"]);
  assert.deepEqual(ok, { spec: { name: "gh", to: "both", kind: "local", command: "npx", args: ["-y", "gh mcp"], url: "", bearer: null, env: [{ key: "GITHUB_TOKEN", var: "GH" }] } });
  assert.deepEqual((checkAdd(f({}), ["codex"]) as { spec: { to: string } }).spec.to, "codex", "only enabled hosts");
  const remote = checkAdd(f({ kind: "remote", url: "https://charts.example.com/mcp", secrets: [{ key: "", var: "CHARTS_TOKEN" }] }), ["claude"]);
  assert.deepEqual(remote, { spec: { name: "gh", to: "claude", kind: "remote", command: "", args: [], url: "https://charts.example.com/mcp", bearer: "CHARTS_TOKEN", env: [] } });
  const err = (o: Partial<AddForm>, enabled: ("claude" | "codex")[] = ["claude", "codex"], taken = {}) => (checkAdd(f(o), enabled, taken) as { error?: string }).error;
  assert.match(err({ name: "" })!, /Name the server/);
  assert.match(err({ name: "web fetch" })!, /letters, digits, - and _ only/);
  assert.match(err({ name: "agenticos" })!, /the vault's own server/);
  assert.match(err({ hosts: [] })!, /Choose a host/);
  assert.match(err({ hosts: ["codex"] }, ["claude"])!, /Choose a host/);
  assert.match(err({}, ["claude", "codex"], { codex: new Set(["gh"]) })!, /Codex already has a server named gh/);
  assert.match(err({ command: "" })!, /Give the command/);
  assert.match(err({ command: "npx 'open" })!, /does not close/);
  assert.match(err({ command: "-y npx" })!, /not a flag/);
  assert.match(err({ kind: "remote", url: "ftp://x" })!, /http or https URL/);
  assert.match(err({ kind: "remote", url: "https://u:p@h.example.com/mcp" })!, /Leave credentials out/);
  // A value where a name belongs: lower case (a pasted secret), a token's shape, the key twice.
  // Token shapes built here, so the source holds nothing a secret scanner reads as one.
  const gh = ["gh", "p_"].join("");
  for (const v of ["$gh_token_value", `${gh}AbC123`, `${gh.toUpperCase()}ABC123DEF`, ["AK", "IA1234567890ABCDEF"].join(""), "$"]) assert.match(err({ secrets: [{ key: "GITHUB_TOKEN", var: v }] })!, /never the value itself/, v);
  assert.match(err({ secrets: [{ key: "A", var: "X" }, { key: "A", var: "Y" }] })!, /A is given twice/);
  assert.match(err({ secrets: [{ key: "bad key", var: "X" }] })!, /not a variable name the server can read/);
  assert.match(err({ kind: "remote", url: "https://h.example.com/mcp", secrets: [{ key: "", var: "A" }, { key: "", var: "B" }] })!, /one secret/);
  assert.deepEqual(splitCommand(`node "/opt/my tools/s.js" --flag`), ["node", "/opt/my tools/s.js", "--flag"]);
  assert.equal(splitCommand("x 'y"), null);
});
