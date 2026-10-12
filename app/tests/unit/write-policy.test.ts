import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { SURFACES, SURFACE_IDS, WritePolicy, globToRegExp, parseSurfaces } from "../../src/main/policy/write-policy";
import { workspaceArgs } from "../../../obsidian-plugin/src/data/spacesModel";
import { memoryArgs, recallArgs } from "../../../obsidian-plugin/src/data/brainModel";

const VAULT = "/vaults/demo";
const v = (rel: string) => `${VAULT}/${rel}`;

test("globs: * stays in one segment, /** is the folder and everything below it", () => {
  const g = (glob: string, p: string) => globToRegExp(glob).test(p);
  assert.equal(g("TODO.md", "TODO.md"), true);
  assert.equal(g("TODO.md", "TODOxmd"), false, "the dot is literal");
  assert.equal(g("brain/routines/*.md", "brain/routines/tick.md"), true);
  assert.equal(g("brain/routines/*.md", "brain/routines/sub/tick.md"), false);
  assert.equal(g("brain/memory/**", "brain/memory"), true);
  assert.equal(g("brain/memory/**", "brain/memory/user/profile.md"), true);
  assert.equal(g("brain/memory/**", "brain/memoryx/a.md"), false);
  assert.equal(g("**/x.json", "x.json"), true);
  assert.equal(g("**/x.json", "a/b/x.json"), true);
  assert.equal(g("a?.md", "ab.md"), true);
  assert.equal(g("a?.md", "a/.md"), false);
});

test("every surface cites its HUD module and names at least one write or command", () => {
  assert.ok(SURFACES.length > 0);
  for (const s of SURFACES) {
    assert.match(s.id, /^[a-z]+$/, s.id);
    assert.ok(s.label && s.source, s.id);
    assert.ok(s.writes.length + s.spawns.length > 0, s.id);
    for (const r of s.spawns) assert.ok(!!r.script !== !!r.bin, `${s.id}: a rule names a script or a program, not both`);
    for (const w of [...s.writes, ...(s.except ?? [])]) assert.ok(!w.startsWith("/") && !w.split("/").includes(".."), `${s.id}: ${w} is vault-relative`);
    if (s.scope === "editor") assert.equal(s.spawns.length, 0, `${s.id}: the editor runs nothing`);
  }
  assert.equal(new Set(SURFACE_IDS).size, SURFACE_IDS.length, "ids are unique");
});

test("AOS_APP_WRITE parses into known surfaces; all means every one; unknown ids are reported", () => {
  assert.deepEqual(parseSurfaces("todo"), { ids: ["todo"], unknown: [] });
  assert.deepEqual(parseSurfaces(" todo , nope ,"), { ids: ["todo"], unknown: ["nope"] });
  assert.deepEqual(parseSurfaces(""), { ids: [], unknown: [] });
  assert.deepEqual(parseSurfaces(undefined), { ids: [], unknown: [] });
  assert.deepEqual(parseSurfaces("all").ids, [...SURFACE_IDS]);
  assert.deepEqual(parseSurfaces(["todo", "todo"]).ids, ["todo"]);
});

test("with no surface on, nothing in the vault may be written", () => {
  const p = new WritePolicy(VAULT, []);
  assert.deepEqual(p.ids, []);
  for (const rel of ["TODO.md", "MEMORY.md", "brain/config.json", "brain/notifications/state.json"]) assert.equal(p.canWrite(v(rel)), false, rel);
});

test("To-Do may write TODO.md and nothing that only looks like it", () => {
  const p = new WritePolicy(VAULT, ["todo"]);
  assert.equal(p.canWrite(v("TODO.md")), true);
  assert.equal(p.canWrite(`${VAULT}/brain/../TODO.md`), true, "the same file, spelled with ..");
  assert.equal(p.canWrite(`${VAULT}//TODO.md`), true);
  for (const target of [
    v("TODO.md.bak"), v("TODO.mdx"), v("todo.md"), v("sub/TODO.md"), v("TODO.md/x"),
    `${VAULT}-evil/TODO.md`, "/vaults/demox/TODO.md", `${VAULT}/../demo-evil/TODO.md`, "/TODO.md",
    `${VAULT}/TODO.md/../brain/config.json`, `${VAULT}/brain/../../TODO.md`,
    "TODO.md", "./TODO.md", "", VAULT, `${VAULT}/`, `${VAULT}/TODO.md\0.png`,
  ]) assert.equal(p.canWrite(target), false, JSON.stringify(target));
  assert.equal(p.canWrite(undefined), false);
  assert.equal(p.canWrite(3), false, "a descriptor is not a path");
});

test("paths as Buffers and file: URLs are checked like strings", () => {
  const p = new WritePolicy(VAULT, ["todo"]);
  assert.equal(p.canWrite(Buffer.from(v("TODO.md"))), true);
  assert.equal(p.canWrite(Buffer.from(v("MEMORY.md"))), false);
  assert.equal(p.canWrite(pathToFileURL(v("TODO.md"))), true);
  assert.equal(p.canWrite(new URL("https://example.com/TODO.md")), false);
});

test("a vault reached through a symlink is the same vault under either spelling", () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), "aos-policy-"));
  const link = `${real}-link`;
  fs.symlinkSync(real, link);
  try {
    const p = new WritePolicy(link, ["todo"]);
    assert.equal(p.canWrite(path.join(link, "TODO.md")), true);
    assert.equal(p.canWrite(path.join(fs.realpathSync(real), "TODO.md")), true);
    assert.equal(p.canWrite(path.join(link, "MEMORY.md")), false);
  } finally {
    fs.rmSync(link, { force: true });
    fs.rmSync(real, { recursive: true, force: true });
  }
});

test("no vault, or a relative one, allows nothing", () => {
  assert.equal(new WritePolicy(null, ["todo"]).canWrite("/TODO.md"), false);
  assert.equal(new WritePolicy("vault", ["todo"]).canWrite(path.resolve("vault/TODO.md")), false);
});

test("unknown surface names enable nothing", () => {
  const p = new WritePolicy(VAULT, ["nope", "TODO"]);
  assert.deepEqual(p.ids, []);
  assert.equal(p.canWrite(v("TODO.md")), false);
});

test("a folder may be created where an allowed file could live, and nowhere else", () => {
  const p = new WritePolicy(VAULT, ["capture", "notifications", "routines"]);
  for (const rel of ["brain", "brain/memory", "brain/memory/user", "brain/memory/feedback/_drafts", "brain/patterns", "brain/_index", "brain/notifications", "brain/routines"]) {
    assert.equal(p.canMakeFolder(v(rel)), true, rel);
  }
  for (const rel of ["persona", "brain/routines/sub", "brain/notifications/x", "brain/_index/agent-runs", "brain/memoryx"]) {
    assert.equal(p.canMakeFolder(v(rel)), false, rel);
  }
  assert.equal(p.canWrite(v("brain/memory/user")), false, "a folder it may create is not one it may remove");
  assert.equal(new WritePolicy(VAULT, ["todo"]).canMakeFolder(v("brain")), false);
});

test("capture writes Markdown under brain/memory only, whatever the typed slug", () => {
  const p = new WritePolicy(VAULT, ["capture"]);
  assert.equal(p.canWrite(v("brain/memory/user/tide-tables.md")), true);
  assert.equal(p.canWrite(v("brain/memory/user/sub/deep.md")), true);
  assert.equal(p.canWrite(v("brain/patterns/testing.md")), true);
  assert.equal(p.canWrite(v("brain/_index/SESSION.md")), true);
  assert.equal(p.canWrite(`${VAULT}/brain/memory/user/../../../TODO.md`), false, "a slug of ../../../TODO");
  assert.equal(p.canWrite(`${VAULT}/brain/memory/user/../../config.json`), false);
  assert.equal(p.canWrite(v("brain/memory/user/x.json")), false);
  assert.equal(p.canWrite(v("brain/_index/BRAIN.md")), false);
});

const NODE = "/usr/local/bin/node";
const S = `${VAULT}/brain/scripts`;
const expect = JSON.stringify({ ts: "2026-09-29T10:00:00Z", id: "harbor-01" });

/** A command each surface runs, and one it must never run. */
const COMMANDS: Record<string, { ok: Array<[string, string[]]>; no: Array<[string, string[]]> }> = {
  notifications: { ok: [], no: [] },
  settings: {
    ok: [[NODE, [`${S}/cli/aos.js`, "config", "set", "claude.model", "opus", "--json"]], [NODE, [`${S}/cli/aos.js`, "config", "set", "recallRoots", '["a","b"]', "--json"]],
      [NODE, [`${S}/cli/aos.js`, "config", "unset", "cost.monthlyBudget", "--json"]], [NODE, [`${S}/cli/aos.js`, "routines", "sync"]],
      [NODE, [`${S}/cli/aos.js`, "statusline", "install"]], ["/bin/zsh", ["-lic", "command -v node"]]],
    no: [[NODE, [`${S}/cli/aos.js`, "config", "set", "--vault", "x", "--json"]], [NODE, [`${S}/cli/aos.js`, "config", "set", "a", "b"]],
      [NODE, [`${S}/cli/aos.js`, "uninstall"]], [NODE, [`${S}/cli/aos.js`, "upgrade"]], ["/bin/zsh", ["-lic", "rm -rf ~"]], ["/bin/zsh", ["-c", "command -v node"]]],
  },
  routines: {
    ok: [[NODE, [`${S}/cli/aos.js`, "routines", "sync"]], [NODE, [`${S}/routines/run-routine.js`, "morning-brief", "--manual"]]],
    no: [[NODE, [`${S}/routines/run-routine.js`, "../x", "--manual"]], [NODE, [`${S}/routines/run-routine.js`, "tick"]], [NODE, [`${S}/cli/aos.js`, "routines", "uninstall"]]],
  },
  sharing: {
    ok: [[NODE, [`${S}/cli/aos.js`, "skills", "exclude", "agenticos:wrap"]], [NODE, [`${S}/cli/aos.js`, "agents", "include", "dev-linus"]]],
    no: [[NODE, [`${S}/cli/aos.js`, "skills", "exclude", "--all"]], [NODE, [`${S}/cli/aos.js`, "skills", "remove", "x"]]],
  },
  pulse: {
    ok: [[NODE, [`${S}/auto-cost.js`, "--backfill"]], [NODE, [`${S}/heartbeat-writer.js`]], [NODE, [`${S}/graph-build.js`, "--quiet"]], [NODE, [`${S}/build-brain-md.js`]],
      [NODE, [`${S}/cost-budget.js`, "--anchor", "12.5"]], [NODE, [`${S}/sdk/reflect-week.js`, "--local"]], [NODE, [`${S}/map-workspace.js`, "harbor app"]], [NODE, [`${S}/persona/briefing.js`, "--force"]]],
    no: [[NODE, [`${S}/cost-budget.js`, "--anchor", "-3"]], [NODE, [`${S}/cost-budget.js`, "--reset"]], [NODE, [`${S}/sdk/reflect-week.js`]], [NODE, [`${S}/persona/briefing.js`, "--root", "/tmp"]]],
  },
  brain: {
    ok: [[NODE, [`${S}/cli/aos.js`, "memory", "keep", "brain/memory/reference/release-checklist.md", "--json"]],
      [NODE, [`${S}/cli/aos.js`, "memory", "archive", "brain/memory/feedback/a.md", "brain/memory/projects/v1.5.0-shipped.md", "--json"]],
      [NODE, [`${S}/cli/aos.js`, "memory", "set", "brain/memory/feedback/a.md", "--set", '{"pin":true}', "--expect", "a".repeat(64), "--json"]],
      [NODE, [`${S}/cli/aos.js`, "memory", "draft", "reject", "ack-failures", "--json"]], [NODE, [`${S}/brain-hub.js`]],
      // PR 3: each hygiene fix, dry run and real; the recall preview (brain-hub D18, D20).
      [NODE, [`${S}/cli/aos.js`, "memory", "fix", "sources", "--dry-run", "--json"]], [NODE, [`${S}/cli/aos.js`, "memory", "fix", "index", "--json"]],
      [NODE, [`${S}/cli/aos.js`, "memory", "fix", "drafts", "--dry-run", "--json"]],
      [NODE, [`${S}/sdk/recall-cli.js`, "release procedure", "--limit", "8", "--json"]], [NODE, [`${S}/sdk/recall-cli.js`, "what - is due?", "--limit", "12", "--json"]]],
    no: [[NODE, [`${S}/cli/aos.js`, "memory", "keep", "brain/memory/feedback/../../../TODO.md", "--json"]], [NODE, [`${S}/cli/aos.js`, "memory", "list", "--json"]],
      [NODE, [`${S}/cli/aos.js`, "memory", "set", "brain/memory/feedback/a.md", "--set", '{"pin":true}', "--json"]], [NODE, [`${S}/brain-hub.js`, "--json"]],
      [NODE, [`${S}/cli/aos.js`, "memory", "fix", "everything", "--json"]], [NODE, [`${S}/cli/aos.js`, "memory", "fix", "sources"]],
      [NODE, [`${S}/cli/aos.js`, "memory", "fix", "sources", "--json", "--dry-run"]], [NODE, [`${S}/cli/aos.js`, "memory", "fix", "--dry-run", "--json"]],
      [NODE, [`${S}/sdk/recall-cli.js`, "--warm"]], [NODE, [`${S}/sdk/recall-cli.js`, "--warm", "--limit", "8", "--json"]],
      [NODE, [`${S}/sdk/recall-cli.js`, "-x", "--limit", "8", "--json"]], [NODE, [`${S}/sdk/recall-cli.js`, " lead", "--limit", "8", "--json"]],
      [NODE, [`${S}/sdk/recall-cli.js`, "two" + String.fromCharCode(10) + "lines", "--limit", "8", "--json"]],
      [NODE, [`${S}/sdk/recall-cli.js`, "sep" + String.fromCharCode(0x2028) + "x", "--limit", "8", "--json"]],
      [NODE, [`${S}/sdk/recall-cli.js`, "x".repeat(201), "--limit", "8", "--json"]], [NODE, [`${S}/sdk/recall-cli.js`, "q", "--limit", "100", "--json"]],
      [NODE, [`${S}/sdk/recall-cli.js`, "q", "--json"]], [NODE, [`${S}/sdk/recall-cli.js`, "q", "--limit", "8"]], [NODE, [`${S}/sdk/recall-cli.js`, "a", "b", "--limit", "8", "--json"]]],
  },
  spaces: {
    ok: [[NODE, [`${S}/map-workspace.js`, "harbor"]], [NODE, [`${S}/map-workspace.js`, "harbor", "--file", "src/tide.ts"]], [NODE, [`${S}/regen-workspace-insight.js`, "harbor"]],
      [NODE, [`${S}/cli/aos.js`, "workspace", "new", "harbor-map", "--git", "--pin", "--json"]], [NODE, [`${S}/cli/aos.js`, "workspace", "draft", "harbor", "--json"]],
      [NODE, [`${S}/cli/aos.js`, "workspace", "archive", "harbor", "--json"]]],
    no: [[NODE, [`${S}/map-workspace.js`, "--all"]], [NODE, [`${S}/map-workspace.js`, "../../etc"]], [NODE, [`${S}/cli/aos.js`, "workspace", "new", "My App", "--json"]],
      [NODE, [`${S}/cli/aos.js`, "workspace", "stubs", "harbor", "--pin"]]],
  },
  teams: {
    ok: [[NODE, [`${S}/team.js`, "init"]], [NODE, [`${S}/team.js`, "gate", "approve", "example", "harbor-01", "--expect", expect]],
      [NODE, [`${S}/team.js`, "gate", "approve", "example", "harbor-01", "--expect", expect, "--usd", "5"]],
      [NODE, [`${S}/team.js`, "budget", "example", "harbor-01", "12", "--expect", expect]], [NODE, [`${S}/team.js`, "pause", "example"]],
      [NODE, [`${S}/team.js`, "resume", "example", "dev-woz"]], [NODE, [`${S}/team.js`, "set", "example", "dev-woz", "model", "claude-opus-5-5[1m]"]],
      [NODE, [`${S}/team.js`, "member", "remove", "example", "dev-woz"]], [NODE, [`${S}/team.js`, "post", "example", "--from", "user", "--kind", "note", "@lead ship it"]]],
    no: [[NODE, [`${S}/team.js`, "gate", "approve", "example", "harbor-01"]], [NODE, [`${S}/team.js`, "budget", "example", "harbor-01", "12"]],
      // A message that merely contains the flag is not the flag.
      [NODE, [`${S}/team.js`, "gate", "approve", "example", "harbor-01", `note --expect ${expect}`]],
      [NODE, [`${S}/team.js`, "post", "example", "--from", "lead", "--kind", "note", "hi"]], [NODE, [`${S}/team.js`, "gate", "redirect", "example", "harbor-01", "--expect", expect]],
      [NODE, [`${S}/team.js`, "disband", "example"]]],
  },
  chat: {
    ok: [[NODE, [`${S}/sdk/recall-cli.js`, "where are the tide notes?"]],
      // One leading dash is text to both scripts, as in Obsidian: a question typed as a bullet.
      [NODE, [`${S}/sdk/recall-cli.js`, "- what is due?"]], [NODE, [`${S}/sdk/ask.js`, "--local", "-v means verbose?"]],
      ["/opt/me/.local/bin/claude", ["-p", "QUESTION: hi", "--model", "sonnet", "--tools", "", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence", "--system-prompt", "You answer.", "--max-budget-usd", "0.25", "--output-format", "json"]],
      ["claude", ["-p", "QUESTION: hi", "--model", "sonnet", "--effort", "high", "--tools", "", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence", "--system-prompt", "You answer.", "--max-budget-usd", "0.25", "--output-format", "json"]],
      // Vault's chosen host, model and effort (spec 2026-10-07-sessions-ux U9): Claude's five levels; ask.js one argument each.
      ["claude", ["-p", "QUESTION: hi", "--model", "opus", "--effort", "max", "--tools", "", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence", "--system-prompt", "You answer.", "--max-budget-usd", "0.25", "--output-format", "json"]],
      [NODE, [`${S}/sdk/ask.js`, "--local", "--host=codex", "what is due?"]],
      [NODE, [`${S}/sdk/ask.js`, "--local", "--host=codex", "--model=gpt-6-luna", "what is due?"]],
      [NODE, [`${S}/sdk/ask.js`, "--local", "--host=codex", "--model=gpt-6-luna", "--effort=xhigh", "what is due?"]],
      [NODE, [`${S}/sdk/ask.js`, "--local", "--host=codex", "--effort=low", "- what is due?"]]],
    no: [["claude", ["-p", "hi"]], ["claude", ["-p", "QUESTION: hi", "--model", "sonnet", "--tools", "Bash", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence", "--system-prompt", "x", "--max-budget-usd", "0.25", "--output-format", "json"]],
      ["claude", ["-p", "QUESTION: hi", "--model", "sonnet", "--tools", "", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence", "--system-prompt", "x", "--max-budget-usd", "0.25", "--output-format", "json", "--dangerously-skip-permissions"]],
      [NODE, [`${S}/sdk/ask.js`, "hi"]], [NODE, [`${S}/sdk/recall-cli.js`, "--dump"]],
      // Whole `--…` arguments are the scripts' flags: a rebuild, or ask.js printing a file as its answer.
      [NODE, [`${S}/sdk/recall-cli.js`, "--warm"]], [NODE, [`${S}/sdk/ask.js`, "--local", "--write=/etc/hosts"]], [NODE, [`${S}/sdk/ask.js`, "--local", ""]],
      [NODE, [`${S}/sdk/recall-cli.js`, "tides", "--limit", "50"]],
      // A host that is not one, a model that reads as a flag, a level ask.js's Codex path does not take, a model with no host.
      ["claude", ["-p", "QUESTION: hi", "--model", "opus", "--effort", "ultra", "--tools", "", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence", "--system-prompt", "x", "--max-budget-usd", "0.25", "--output-format", "json"]],
      [NODE, [`${S}/sdk/ask.js`, "--local", "--host=ollama", "hi"]], [NODE, [`${S}/sdk/ask.js`, "--local", "--host=codex", "--model=-x", "hi"]],
      [NODE, [`${S}/sdk/ask.js`, "--local", "--host=codex", "--effort=ultra", "hi"]], [NODE, [`${S}/sdk/ask.js`, "--local", "--model=gpt-6-luna", "hi"]],
      [NODE, [`${S}/sdk/ask.js`, "--local", "--host=codex", "--effort=low", "--model=gpt-6-luna", "hi"]]],
  },
};

test("each surface's commands run only while it is on; its look-alikes never", () => {
  const none = new WritePolicy(VAULT, []);
  const all = new WritePolicy(VAULT, [...SURFACE_IDS]);
  for (const [id, { ok, no }] of Object.entries(COMMANDS)) {
    assert.ok(SURFACE_IDS.includes(id), id);
    const on = new WritePolicy(VAULT, [id]);
    for (const [cmd, args] of ok) {
      assert.equal(on.canSpawn(cmd, args), true, `${id} on: ${cmd} ${args.join(" ")}`);
      assert.equal(none.canSpawn(cmd, args), false, `nothing on: ${cmd} ${args.join(" ")}`);
    }
    for (const [cmd, args] of no) assert.equal(all.canSpawn(cmd, args), false, `never: ${cmd} ${args.join(" ")}`);
  }
});

test("map and regen take a workspace name (WS) and a file inside it (REL), never a path out (spaces-redesign §6)", () => {
  const spaces = new WritePolicy(VAULT, ["spaces"]);
  const pulse = new WritePolicy(VAULT, ["pulse"]);
  const all = new WritePolicy(VAULT, [...SURFACE_IDS]);
  const map = (...a: string[]) => [`${S}/map-workspace.js`, ...a];
  const regen = (...a: string[]) => [`${S}/regen-workspace-insight.js`, ...a];
  // What a workspace name and a file inside one may look like.
  for (const name of ["harbor", "harbor-map", "Field Notes", "a.b", "café", "x".repeat(128)]) {
    assert.equal(spaces.canSpawn(NODE, map(name)), true, `spaces map ${name}`);
    assert.equal(spaces.canSpawn(NODE, regen(name)), true, `spaces regen ${name}`);
    assert.equal(pulse.canSpawn(NODE, map(name)), true, `pulse map ${name}`);
  }
  for (const file of ["src/tide.ts", "README.md", ".github/workflows/ci.yml", "notes/a b.md", "a\\b.md", "_drafts/x.md", "x..y.md", "a/.hidden"]) {
    assert.equal(spaces.canSpawn(NODE, map("harbor", "--file", file)), true, `--file ${file}`);
  }
  // What the page never runs, whatever is on: hidden, archived and dot names, separators, flags, line breaks, paths out.
  const badNames = ["..", ".", "_archive", "_archive/x", "_spikes", ".hidden", "a\\b", "-x", "--all", "har\nbor", "\nharbor", "harbor\r",
    "../x", "/etc/x", "a/b", "", " harbor", "x".repeat(129), "a\0b", "\0x", "a\u2028b", "a\u2029b", "\u2028a"];
  for (const name of badNames) {
    assert.equal(all.canSpawn(NODE, map(name)), false, `map ${JSON.stringify(name)}`);
    assert.equal(all.canSpawn(NODE, regen(name)), false, `regen ${JSON.stringify(name)}`);
    assert.equal(all.canSpawn(NODE, map(name, "--file", "src/tide.ts")), false, `map ${JSON.stringify(name)} --file`);
  }
  const badFiles = ["..", ".", "../x", "/etc/x", "-x", "--budget", "a\nb", "src/tide.ts\n", "a\rb", "src/../../x", "src/..", "./src/tide.ts",
    "src/./tide.ts", "a\u2028/../x", "a\u2029/..", "a\0b", ""];
  for (const file of badFiles) assert.equal(all.canSpawn(NODE, map("harbor", "--file", file)), false, `--file ${JSON.stringify(file)}`);
  // The rules' shape: one name; --file only with its value, after the name; no other flag.
  assert.equal(all.canSpawn(NODE, map("harbor", "src/tide.ts")), false);
  assert.equal(all.canSpawn(NODE, map("--file", "src/tide.ts", "harbor")), false);
  assert.equal(all.canSpawn(NODE, map("harbor", "--file")), false);
  assert.equal(all.canSpawn(NODE, regen("harbor", "--file", "src/tide.ts")), false);
  assert.equal(pulse.canSpawn(NODE, map("harbor", "--file", "src/tide.ts")), false, "Pulse maps whole workspaces only");
});

test("Brain's recall preview: one query that is never a flag, --limit with one or two digits, --json; only Brain (brain-hub D18)", () => {
  const brain = new WritePolicy(VAULT, ["brain"]);
  const others = new WritePolicy(VAULT, SURFACE_IDS.filter((id) => id !== "brain"));
  const all = new WritePolicy(VAULT, [...SURFACE_IDS]);
  const rc = (...a: string[]): string[] => [`${S}/sdk/recall-cli.js`, ...a];
  for (const a of [rc("release procedure", "--limit", "8", "--json"), rc("what - is due?", "--limit", "1", "--json"), rc("x".repeat(200), "--limit", "99", "--json")]) {
    assert.equal(brain.canSpawn(NODE, a), true, a.join(" "));
    assert.equal(others.canSpawn(NODE, a), false, `only Brain: ${a.join(" ")}`);
  }
  const no = [
    rc("--warm"), rc("--warm", "--limit", "8", "--json"), rc("-x", "--limit", "8", "--json"), rc(" lead", "--limit", "8", "--json"),
    rc("two" + String.fromCharCode(10) + "lines", "--limit", "8", "--json"), rc("sep" + String.fromCharCode(0x2028) + "x", "--limit", "8", "--json"),
    rc("nul" + String.fromCharCode(0) + "x", "--limit", "8", "--json"), rc("x".repeat(201), "--limit", "8", "--json"),
    rc("q", "--limit", "100", "--json"), rc("q", "--limit", "-1", "--json"), rc("q", "--json"), rc("q", "--limit", "8"),
    rc("a", "b", "--limit", "8", "--json"), rc("q", "--json", "--limit", "8"),
  ];
  for (const a of no) assert.equal(all.canSpawn(NODE, a), false, `never: ${JSON.stringify(a.slice(1))}`);
  // Whatever is typed, the HUD's builder hands the rule an argv it admits: a leading run of dashes and spaces, however
  // mixed, never reaches it (so the page never blames the surface for a pasted bullet).
  for (const typed of ["- - release notes", "-- --warm", "- -x", "-\t-x", "  --warm  now ", "- what is due?", "a - b"]) {
    assert.equal(brain.canSpawn(NODE, rc(...recallArgs(typed))), true, JSON.stringify(typed));
  }
});

test("Brain runs exactly the page's memory verbs: memory paths only, 1–50 per call, set compare-and-set, --json last (brain-hub D13, D14)", () => {
  const brain = new WritePolicy(VAULT, ["brain"]);
  const others = new WritePolicy(VAULT, SURFACE_IDS.filter((id) => id !== "brain"));
  const all = new WritePolicy(VAULT, [...SURFACE_IDS]);
  const mem = (...a: string[]): string[] => [`${S}/cli/aos.js`, "memory", ...a];
  const A = "brain/memory/feedback/prefer-small-diffs.md";
  const B = "brain/memory/reference/tide-api-notes.md";
  const ok = [
    mem("keep", A, "--json"), mem("keep", A, B, "--json"), mem("restore", B, "--json"), mem("archive", A, "--json"),
    mem("keep", ...Array.from({ length: 50 }, (_, i) => `brain/memory/reference/r${i}.md`), "--json"),
    mem("set", A, "--set", '{"status":"complete"}', "--expect", "0123456789abcdef", "--json"),
    mem("set", A, "--set", '{"pin":false}', "--expect", "a".repeat(64), "--dry-run", "--json"),
    mem("supersede", A, "--by", B, "--json"), mem("draft", "approve", "ack-failures.v2", "--json"), mem("notdup", A, B, "--json"),
    // PR 3: Health's fixes, each kind with and without its dry run (D20), and the real run pinned to the dry run's hash.
    ...["sources", "types", "descriptions", "index", "drafts"].flatMap((k) => [mem("fix", k, "--dry-run", "--json"), mem("fix", k, "--json"), mem("fix", k, "--expect", "0123456789abcdef0123456789abcdef", "--json")]),
    // Bootstrap's bulk Mark complete: each set skips its BRAIN.md rebuild, then build-brain-md runs once.
    mem("set", A, "--set", '{"status":"complete"}', "--expect", "a".repeat(64), "--skip-brain-md", "--json"),
  ];
  for (const a of ok) {
    assert.equal(brain.canSpawn(NODE, a), true, a.join(" "));
    assert.equal(others.canSpawn(NODE, a), false, `only Brain: ${a.join(" ")}`);
  }
  // The page's own builder (brainModel memoryArgs) for the fix it confirms and the bulk set: the surface admits both.
  assert.equal(brain.canSpawn(NODE, [`${S}/cli/aos.js`, ...memoryArgs({ verb: "fix", kind: "index", dryRun: false, expect: "f".repeat(32) })]), true);
  assert.equal(brain.canSpawn(NODE, [`${S}/cli/aos.js`, ...memoryArgs({ verb: "set", path: A, fields: { status: "complete" }, expect: "a".repeat(64), skipBrainMd: true })]), true);
  assert.equal(brain.canSpawn(NODE, [`${S}/brain-hub.js`]), true);
  assert.equal(brain.canSpawn(NODE, [`${S}/build-brain-md.js`]), true);
  assert.equal(brain.canSpawn(NODE, [`${S}/build-brain-md.js`, "--json"]), false);
  const no = [
    mem("keep", "--json"), mem("keep", A), mem("keep", A, "--json", B), mem("keep", "--json", A),
    mem("keep", ...Array.from({ length: 51 }, (_, i) => `brain/memory/reference/r${i}.md`), "--json"),
    // Not a memory: a draft, a README, a sub-folder, a climb, another folder, a capital, a dash-led slug, an absolute path.
    mem("keep", "brain/memory/feedback/_drafts/x.md", "--json"), mem("keep", "brain/memory/user/README.MD", "--json"),
    mem("keep", "brain/memory/user/sub/x.md", "--json"), mem("archive", "brain/memory/user/../../TODO.md", "--json"),
    mem("archive", "brain/patterns/debugging.md", "--json"), mem("keep", "brain/memory/user/Profile.md", "--json"),
    mem("keep", "brain/memory/user/-x.md", "--json"), mem("keep", "/etc/hosts", "--json"),
    mem("set", A, "--set", '{"pin":true}', "--json"), mem("set", A, "--set", "pin", "--expect", "none", "--json"),
    mem("set", A, "--set", '{"pin":true}', "--expect", "XYZ", "--json"), mem("set", A, "--set", '{"pin":true}', "--dry-run", "--expect", "none", "--json"),
    mem("supersede", A, "--json"), mem("supersede", A, "--by", "brain/memory/x.md", "--json"),
    mem("draft", "delete", "x", "--json"), mem("draft", "approve", "../x", "--json"), mem("draft", "approve", "-x", "--json"),
    mem("notdup", A, "--json"), mem("list", "--json"), mem("list"),
    // A fix: only the five kinds, --dry-run before --json, nothing after it, no second kind.
    mem("fix", "index"), mem("fix", "all", "--json"), mem("fix", "--json"), mem("fix", "index", "--json", "--dry-run"),
    mem("fix", "index", "sources", "--json"), mem("fix", "Index", "--json"), mem("fix", "index", "--dry-run"),
    // --expect: only a dry run's 32 hex characters, never beside --dry-run, before --json.
    mem("fix", "index", "--expect", "none", "--json"), mem("fix", "index", "--expect", "abc", "--json"), mem("fix", "index", "--expect", "A".repeat(32), "--json"),
    mem("fix", "index", "--dry-run", "--expect", "0".repeat(32), "--json"), mem("fix", "index", "--expect", "0".repeat(32)),
    mem("fix", "index", "--json", "--expect", "0".repeat(32)),
    // --skip-brain-md: set's only, after its --expect.
    mem("keep", A, "--skip-brain-md", "--json"), mem("set", A, "--skip-brain-md", "--set", '{"pin":true}', "--expect", "none", "--json"),
  ];
  for (const a of no) assert.equal(all.canSpawn(NODE, a), false, `never: ${a.join(" ")}`);
  assert.equal(all.canSpawn(NODE, [`${S}/brain-hub.js`, "--dry-run"]), false);
  // The page never writes a memory, MEMORY.md or the trail itself: Pulse no longer may (D14), and Brain writes nothing.
  for (const id of ["brain", "pulse"]) {
    const p = new WritePolicy(VAULT, [id]);
    for (const rel of [A, "MEMORY.md", "brain/_index/promote-log.jsonl", "brain/_index/brain-hub.json"]) assert.equal(p.canWrite(`${VAULT}/${rel}`), false, `${id}: ${rel}`);
  }
});

test("Spaces runs exactly the page's workspace verbs, each flag in one fixed place (spaces-redesign §4 PR 3, D29)", () => {
  const spaces = new WritePolicy(VAULT, ["spaces"]);
  const none = new WritePolicy(VAULT, []);
  const others = new WritePolicy(VAULT, SURFACE_IDS.filter((id) => id !== "spaces"));
  const all = new WritePolicy(VAULT, [...SURFACE_IDS]);
  const ws = (...a: string[]) => [`${S}/cli/aos.js`, "workspace", ...a];
  const h16 = "0123456789abcdef";
  const h64 = "ab".repeat(32);
  const set = JSON.stringify({ status: "paused", objectives: ["ship -x", "--json"] });
  const ok: string[][] = [
    // new: each combination of its optional flags, always in the order --git, --pin, --empty.
    ...[[], ["--git"], ["--pin"], ["--git", "--pin"], ["--empty"], ["--git", "--empty"], ["--pin", "--empty"], ["--git", "--pin", "--empty"]]
      .map((flags) => ws("new", "harbor-map", ...flags, "--json")),
    ws("new", "a", "--json"), ws("new", "x".repeat(64), "--pin", "--json"), ws("new", "2026-tide-notes", "--empty", "--json"),
    ws("draft", "harbor", "--json"), ws("draft", "Field Notes", "--json"),
    ws("set", "harbor", "--set", set, "--expect", "none", "--json"), ws("set", "harbor", "--set", "{}", "--expect", h16, "--dry-run", "--json"),
    ws("set", "Field Notes", "--set", set, "--expect", h64, "--json"),
    ws("archive", "harbor", "--json"), ws("restore", "harbor", "--json"), ws("rename", "Field Notes", "field-notes", "--json"),
    ws("adopt", "~/code/harbor", "--into", "harbor", "--json"), ws("adopt", "/opt/src/harbor app", "--into", "Field Notes", "--json"),
    ws("hide", "~/scratch/old", "--json"), ws("unhide", "/Volumes/work/x", "--json"),
  ];
  for (const args of ok) {
    const what = JSON.stringify(args.slice(1));
    assert.equal(spaces.canSpawn(NODE, args), true, `spaces on: ${what}`);
    assert.equal(none.canSpawn(NODE, args), false, `nothing on: ${what}`);
    assert.equal(others.canSpawn(NODE, args), false, `every surface but Spaces: ${what}`);
  }
  const no: string[][] = [
    // The plan's cases: a name that is not kebab-case, a path for a new name, adopt's move form (terminals only) and an
    // unknown flag, set without the compare-and-set.
    ws("new", "My App", "--json"), ws("new", "My", "App", "--json"), ws("rename", "a", "../b", "--json"),
    ws("adopt", "~/code/harbor", "--json"), ws("adopt", "~/code/harbor", "--into", "harbor", "--name", "x", "--json"),
    ws("adopt", "~/code/harbor", "--name", "harbor", "--json"), ws("set", "harbor", "--set", set, "--json"), ws("set", "harbor", "--set", set, "--dry-run", "--json"),
    // Flags out of order.
    ws("new", "harbor-map", "--pin", "--git", "--json"), ws("new", "harbor-map", "--empty", "--git", "--json"), ws("new", "harbor-map", "--json", "--pin"),
    ws("new", "--git", "harbor-map", "--json"), ws("set", "harbor", "--expect", "none", "--set", set, "--json"),
    ws("set", "harbor", "--set", set, "--dry-run", "--expect", "none", "--json"), ws("set", "harbor", "--set", set, "--expect", "none", "--json", "--dry-run"),
    ws("adopt", "--into", "harbor", "~/code/harbor", "--json"), ws("archive", "--json", "harbor"),
    // A trailing argument, a repeated flag, no --json.
    ws("draft", "harbor", "--json", "extra"), ws("archive", "harbor", "--json", "--force"), ws("new", "harbor-map", "--git", "--git", "--json"),
    ws("rename", "a", "b", "c", "--json"), ws("hide", "~/x", "~/y", "--json"), ws("archive", "harbor"), ws("draft", "harbor"), ws("new", "harbor-map"),
    // A leading "-": no value can stand in for a flag.
    ws("new", "-x", "--json"), ws("rename", "harbor", "-x", "--json"), ws("rename", "-x", "harbor", "--json"), ws("draft", "--all", "--json"),
    ws("archive", "-harbor", "--json"), ws("hide", "--all", "--json"), ws("hide", "-/x", "--json"), ws("adopt", "~/code/x", "--into", "-x", "--json"),
    ws("set", "harbor", "--set", set, "--expect", `-${h16}`, "--json"), ws("set", "harbor", "--set", `-${set}`, "--expect", "none", "--json"),
    // A flag inside a value is not the flag.
    ws("adopt", "~/code/x --into harbor", "--json"), ws("set", "harbor", "--set", `${set} --expect none`, "--json"),
    // Terminals and sessions only: stubs, list, which; and verbs that do not exist.
    ws("stubs", "harbor"), ws("stubs", "harbor", "--pin"), ws("stubs", "harbor", "--pin", "--json"), ws("list", "--json"), ws("which", "--json"),
    ws("which", "--cwd", "/tmp", "--json"), ws("delete", "harbor", "--json"), ws("archive|restore", "harbor", "--json"),
    // A new name (KEBAB).
    ...["Harbor", "harbor-", "-harbor", "a_b", "harbor map", "harbor.app", "x".repeat(65), "", "café", "a\nb", "../b", "_x", "a/b"]
      .flatMap((k) => [ws("new", k, "--json"), ws("rename", "harbor", k, "--json")]),
    // An existing name (WS).
    ...["_archive/harbor", "_archive", "../harbor", ".", "..", "a/b", ".hidden", "_x", "har\nbor", "a\u2028b", ""]
      .flatMap((n) => [ws("draft", n, "--json"), ws("archive", n, "--json"), ws("restore", n, "--json"), ws("rename", n, "harbor-2", "--json"),
        ws("adopt", "~/code/x", "--into", n, "--json"), ws("set", n, "--set", set, "--expect", "none", "--json")]),
    // A hash (HASH) and a JSON object.
    ...["", "abc", h16.slice(1), h16.toUpperCase(), "0".repeat(65), "None", "none ", `g${h16.slice(1)}`]
      .map((h) => ws("set", "harbor", "--set", set, "--expect", h, "--json")),
    ...["[]", "null", '"x"', "", "{"].map((j) => ws("set", "harbor", "--set", j, "--expect", "none", "--json")),
    // An outside path (PATH): absolute or ~/, and never "/" or "~/" alone, nor a line break or NUL.
    ...["relative/x", "/", "~/", "~", "~user/x", "./x", "a/../b", "/x\n", "/x\ny", "/a\0b", "/a\rb", "/a\u2028b", "~/a\u2029", ""]
      .flatMap((p) => [ws("adopt", p, "--into", "harbor", "--json"), ws("hide", p, "--json"), ws("unhide", p, "--json")]),
  ];
  for (const args of no) assert.equal(all.canSpawn(NODE, args), false, `never: ${JSON.stringify(args.slice(1))}`);
});

test("every argv the page builds for a workspace verb (spacesModel workspaceArgs) is one the spaces surface admits (D29)", () => {
  const spaces = new WritePolicy(VAULT, ["spaces"]);
  const others = new WritePolicy(VAULT, SURFACE_IDS.filter((id) => id !== "spaces"));
  const h = "ab".repeat(32);
  const sent: string[][] = [
    // NewSpaceModal's templates (Blank, Code repo, Clone), then Code's New workspace sheet (createAndLaunch, no --pin).
    workspaceArgs.new("harbor-map", { git: false, pin: true }), workspaceArgs.new("harbor-map", { git: true, pin: true }),
    workspaceArgs.new("harbor-map", { empty: true }), workspaceArgs.new("harbor-map", { git: false }), workspaceArgs.new("harbor-map", { git: true }),
    workspaceArgs.draft("Field Notes"),
    // The Draft dialog's preview and Save, the status menu, the pin toggle, Link as code folder and the link dialog.
    workspaceArgs.set("harbor", { summary: "A -- b", objectives: ["--json"], next: "n", status: "paused" }, h, { dryRun: true }),
    workspaceArgs.set("harbor", { status: "" }, "none"), workspaceArgs.set("harbor", { pinned: false }, h),
    workspaceArgs.set("harbor", { repo: "~/code/x" }, h), workspaceArgs.set("harbor", { repo: "" }, h),
    workspaceArgs.archive("harbor"), workspaceArgs.restore("harbor-2026-10-10"), workspaceArgs.rename("Field Notes", "field-notes"),
    workspaceArgs.adopt("/opt/src/harbor app", "harbor"), workspaceArgs.hide("~/code/old"), workspaceArgs.unhide("/Volumes/work/x"),
  ];
  for (const a of sent) {
    assert.equal(spaces.canSpawn(NODE, [`${S}/cli/aos.js`, ...a]), true, `spaces on: ${JSON.stringify(a)}`);
    assert.equal(others.canSpawn(NODE, [`${S}/cli/aos.js`, ...a]), false, `spaces off: ${JSON.stringify(a)}`);
  }
  // What the builders refuse never reaches the surface: they throw before anything runs.
  assert.throws(() => workspaceArgs.new("harbor-map", { git: true, empty: true }));
  assert.throws(() => workspaceArgs.new("My App"));
  assert.throws(() => workspaceArgs.rename("harbor", "../b"));
  assert.throws(() => workspaceArgs.set("harbor", { pinned: true }, "-x"));
  assert.throws(() => workspaceArgs.adopt("relative/x", "harbor"));
  assert.throws(() => workspaceArgs.draft("_archive/harbor"));
});

test("a relative script runs only against the vault it resolves into", () => {
  const p = new WritePolicy(VAULT, ["chat"]);
  assert.equal(p.canSpawn(NODE, ["brain/scripts/sdk/ask.js", "--local", "hi"], VAULT), true, "askSpawner: relative, cwd = the vault");
  assert.equal(p.canSpawn(NODE, ["brain/scripts/sdk/ask.js", "--local", "hi"]), false, "no cwd");
  assert.equal(p.canSpawn(NODE, ["brain/scripts/sdk/ask.js", "--local", "hi"], "/elsewhere"), false);
  assert.equal(p.canSpawn(NODE, ["../brain/scripts/sdk/ask.js", "--local", "hi"], `${VAULT}/persona`), true, "resolves into this vault");
  assert.equal(p.canSpawn(NODE, ["brain/scripts/sdk/ask.js", "--local", "hi"], "relative/cwd"), false);
});

test("settings may create the live-runs folder and summary log, and nothing else under agent-runs", () => {
  const p = new WritePolicy(VAULT, ["settings"]);
  assert.equal(p.canMakeFolder(v("brain/_index/agent-runs/live")), true);
  assert.equal(p.canMakeFolder(v("brain/_index/agent-runs")), true);
  assert.equal(p.canWrite(v("brain/_index/agent-runs/runs.jsonl")), true);
  assert.equal(p.canWrite(v("brain/_index/agent-runs/live")), false, "creating is not removing");
  assert.equal(p.canWrite(v("brain/_index/agent-runs/live/run-1.jsonl")), false);
  assert.equal(p.canMakeFolder(v("brain/_index/agent-runs/other")), false);
  assert.equal(new WritePolicy(VAULT, []).canMakeFolder(v("brain/_index/agent-runs/live")), false);
});

test("Notes lets the note editor save Markdown notes, never the runtime's or vendored files, and nothing else", () => {
  const p = new WritePolicy(VAULT, ["notes"]);
  for (const rel of ["TODO.md", "MEMORY.md", "brain/memory/projects/harbor-map.md", "persona/IDENTITY.md", "2026/2026-09-September/2026-09-29.md"]) {
    assert.equal(p.canSave(v(rel)), true, rel);
  }
  assert.equal(p.canSave(`${VAULT}/brain/_index/../../TODO.md`), true, "resolved before matching");
  for (const target of [
    v("brain/_index/BRAIN.md"), v("brain/_index/proposals/x.md"), v("brain/scripts/README.md"), v(".obsidian/x.md"), v(".git/x.md"),
    v("tools/node_modules/pkg/README.md"), v("TODO.md.bak"), v("brain/config.json"), v("TODO.mdx"), "/elsewhere/TODO.md",
    `${VAULT}/../TODO.md`, "TODO.md", `${VAULT}/brain/memory/../_index/BRAIN.md`,
    // Every dot-path (S7): hidden from the tree, and where the hosts read project config.
    v("notes/.hidden.md"), v(".claude/agents/x.md"), v("workspaces/app/.claude/commands/x.md"), v(".codex/AGENTS.md"),
  ]) assert.equal(p.canSave(target), false, target);
});

test("Files never writes or creates a dot-path: a compromised page cannot plant a host's project config", () => {
  const p = new WritePolicy(VAULT, ["files"]);
  for (const rel of ["workspaces/app/PLAN.md", "notes/a.md", "a/b/c/d.txt", "x.y/z.md"]) assert.equal(p.canWrite(v(rel)), true, rel);
  for (const rel of [".claude/settings.json", ".claude/settings.local.json", ".mcp.json", "workspaces/app/.mcp.json", "workspaces/app/.claude/settings.json",
    ".codex/config.toml", ".git/hooks/pre-commit", ".envrc", "a/.vscode/tasks.json", ".obsidian/app.json"]) assert.equal(p.canWrite(v(rel)), false, rel);
  for (const rel of [".claude", "workspaces/app/.claude", ".git/hooks"]) assert.equal(p.canMakeFolder(v(rel)), false, rel);
  assert.equal(p.canMakeFolder(v("workspaces/new")), true);
});

test("switching Notes on never widens what the HUD may write, and a HUD surface never lets the editor save", () => {
  const notes = new WritePolicy(VAULT, ["notes"]);
  for (const rel of ["TODO.md", "MEMORY.md", "brain/memory/user/x.md", "brain/routines/tick.md"]) assert.equal(notes.canWrite(v(rel)), false, rel);
  assert.equal(notes.canMakeFolder(v("brain/memory/new")), false);
  assert.deepEqual(notes.ids, ["notes"], "the status bar still names it");
  const hud = new WritePolicy(VAULT, SURFACE_IDS.filter((id) => id !== "notes"));
  assert.equal(hud.canWrite(v("TODO.md")), true);
  assert.equal(hud.canSave(v("TODO.md")), false);
});

test("a surface's except globs win over its writes, for the HUD's writes too", () => {
  const table = [{ id: "demo", label: "Demo", source: "test", writes: ["brain/**/*.md"], except: ["brain/_index/**"], spawns: [], verified: true }];
  const p = new WritePolicy(VAULT, ["demo"], table);
  assert.equal(p.canWrite(v("brain/memory/a.md")), true);
  assert.equal(p.canWrite(v("brain/_index/BRAIN.md")), false);
  assert.equal(p.canSave(v("brain/memory/a.md")), false, "a HUD surface");
});
