import { test } from "node:test";
import assert from "node:assert/strict";
import { copyArgs, filterMcp, mcpItems, parseMcpServers, parsePlan, planConfirm, planFor } from "./mcpServers";

// brain/_index/mcp-servers.json as lib/import/mcp.js writes it: the program or URL only.
const LISTING = JSON.stringify({
  schema: 1,
  updatedAt: "2026-10-15T10:00:00.000Z",
  servers: [
    { name: "docs-search", host: "claude", transport: "stdio", command: "npx", scope: "user", enabled: true },
    { name: "issue-tracker", host: "codex", transport: "stdio", command: "~/tools/issue-mcp", scope: "user", enabled: true },
    { name: "shared", host: "claude", transport: "stdio", command: "shared-mcp", scope: "user", enabled: true },
    { name: "shared", host: "codex", transport: "stdio", command: "shared-mcp", scope: "user", enabled: true },
    { name: "tracker", host: "claude", transport: "http", url: "https://localhost:8443/mcp", scope: "user", enabled: true },
    { name: "web fetch", host: "codex", transport: "http", url: "https://fetch.example.com/mcp", scope: "user", enabled: false },
    { name: "paused", host: "codex", transport: "stdio", command: "paused-mcp", scope: "user", enabled: false },
    { name: "bad", host: "cursor" },
    "junk",
  ],
});

test("the listing parses; a missing or broken file reads as not listed", () => {
  const c = parseMcpServers(LISTING);
  assert.equal(c.listed, true);
  assert.equal(c.updatedAt, "2026-10-15T10:00:00.000Z");
  assert.equal(c.servers.length, 7);
  assert.equal(c.servers.find((s) => s.name === "web fetch")?.enabled, false);
  for (const bad of [null, "", "{", "[]", '{"servers":{}}']) assert.deepEqual(parseMcpServers(bad), { listed: false, updatedAt: null, servers: [] }, String(bad));
});

test("one item per name; Make available on the enabled host that lacks it; a remote server's offer to Codex is off with why (B6)", () => {
  const items = mcpItems(parseMcpServers(LISTING), ["claude", "codex"]);
  assert.deepEqual(items.map((i) => [i.name, Object.keys(i.on).sort().join("+"), i.what]), [
    ["docs-search", "claude", "npx"],
    ["issue-tracker", "codex", "~/tools/issue-mcp"],
    ["shared", "claude+codex", "shared-mcp"],
    ["tracker", "claude", "https://localhost:8443/mcp"],
    ["web fetch", "codex", "https://fetch.example.com/mcp"],
  ].concat([["paused", "codex", "paused-mcp"]]).sort((a, b) => a[0].localeCompare(b[0])));
  const by = (n: string) => items.find((i) => i.name === n)!;
  assert.deepEqual(by("docs-search").offers, [{ to: "codex", label: "Make available on Codex", disabled: false, reason: null }]);
  assert.deepEqual(by("issue-tracker").offers, [{ to: "claude", label: "Make available on Claude Code", disabled: false, reason: null }]);
  assert.deepEqual(by("shared").offers, [], "on both: nothing to offer");
  assert.equal(by("tracker").offers[0].disabled, true);
  assert.match(by("tracker").offers[0].reason!, /A remote \(http\) server: `codex mcp add` takes a command to run/);
  assert.equal(by("web fetch").offers[0].disabled, true, "a name Claude Code's CLI refuses");
  assert.match(by("web fetch").offers[0].reason!, /does not take the name "web fetch"/);
  // Turned off on its host: neither CLI's add takes an off state, so it is not copied on as if it were on.
  assert.deepEqual(by("paused").offers, [{ to: "claude", label: "Make available on Claude Code", disabled: true, reason: "Turned off on Codex: turn it on there first, or add it to Claude Code yourself" }]);
});

test("only an enabled host is offered: Claude-only, Codex-only and no host", () => {
  const c = parseMcpServers(LISTING);
  const offers = (enabled: Array<"claude" | "codex">) => mcpItems(c, enabled).flatMap((i) => i.offers.map((o) => `${i.name}→${o.to}`));
  assert.deepEqual(offers(["claude"]), ["issue-tracker→claude", "paused→claude", "web fetch→claude"]);
  assert.deepEqual(offers(["codex"]), ["docs-search→codex", "tracker→codex"]);
  assert.deepEqual(offers([]), []);
});

test("the filter matches a name or its program; the page's argv, --json last; names the surface refuses throw", () => {
  const items = mcpItems(parseMcpServers(LISTING), ["claude", "codex"]);
  assert.deepEqual(filterMcp(items, "npx").map((i) => i.name), ["docs-search"]);
  assert.deepEqual(filterMcp(items, "TRACK").map((i) => i.name), ["issue-tracker", "tracker"]);
  assert.deepEqual(copyArgs("docs-search", "codex", true), ["mcp", "copy", "docs-search", "--to", "codex", "--dry-run", "--json"]);
  // The real run names the dry run's hash, so the confirm runs only what it showed (security review 3).
  const h = "a".repeat(64);
  assert.deepEqual(copyArgs("docs-search", "codex", false, h), ["mcp", "copy", "docs-search", "--to", "codex", "--expect", h, "--json"]);
  assert.throws(() => copyArgs("docs-search", "codex", false), /the dry run's hash/);
  assert.throws(() => copyArgs("docs-search", "codex", false, "abc"), /the dry run's hash/);
  assert.throws(() => copyArgs("web fetch", "claude", true));
  assert.throws(() => copyArgs("-x", "claude", true));
});

test("a dry run's answer becomes the confirm: the file, the backup, the exact command, what is not carried", () => {
  const plan = parsePlan({
    ok: true, dryRun: true, name: "docs-search", from: "claude", to: "codex", transport: "stdio",
    command: "codex mcp add docs-search --env 'LOG_LEVEL=<redacted>' -- npx -y docs-search-mcp", source: "~/.claude.json", file: "~/.codex/config.toml",
    backup: "~/.local/share/unidex/backups/mcp/codex-config.toml-20261015T100000123Z.bak", dropped: ["cwd"], expect: "b".repeat(64),
  });
  assert.ok(plan);
  const c = planConfirm(plan!);
  assert.equal(c.title, "Make docs-search available on Codex?");
  assert.equal(c.confirm, "Add to Codex");
  assert.equal(plan!.expect, "b".repeat(64));
  assert.equal(c.detail, "Writes ~/.codex/config.toml\nBacks it up first to ~/.local/share/unidex/backups/mcp/codex-config.toml-20261015T100000123Z.bak\n\ncodex mcp add docs-search --env 'LOG_LEVEL=<redacted>' -- npx -y docs-search-mcp");
  assert.match(c.message, /^Copies docs-search from Claude Code \(~\/\.claude\.json\) through Codex's own CLI\./);
  assert.match(c.message, /Not carried over: cwd\./);
  assert.equal(parsePlan({ ok: false }), null);
  assert.equal(parsePlan({ ...plan!, expect: undefined }), null, "a plan without its hash cannot be confirmed");
  assert.equal(parsePlan({ ok: true, command: "x", file: "y", name: "n", from: "cursor", to: "codex" }), null);
  assert.equal(planConfirm({ ...plan!, backup: null }).detail.split("\n")[1], "No backup: the file does not exist yet");
});

test("a dry run's answer is offered for confirm only when it is the one asked for: the same server and target (security re-review E)", () => {
  const answer = {
    ok: true, dryRun: true, name: "docs-search", from: "claude", to: "codex", transport: "stdio", command: "codex mcp add docs-search -- npx",
    source: "~/.claude.json", file: "~/.codex/config.toml", backup: null, dropped: [], expect: "c".repeat(64),
  };
  assert.equal(planFor(answer, "docs-search", "codex")?.name, "docs-search");
  assert.equal(planFor(answer, "docs-search", "claude"), null, "another target");
  assert.equal(planFor(answer, "other", "codex"), null, "another server");
  assert.equal(planFor({ ...answer, dryRun: false }, "docs-search", "codex", true), null, "a real run's answer is not a dry run's");
  assert.equal(planFor({ ok: false }, "docs-search", "codex"), null);
});
