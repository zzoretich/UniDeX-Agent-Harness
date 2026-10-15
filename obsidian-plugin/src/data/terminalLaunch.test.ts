import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "module";
import {
  slugify, isReserved, workspaceStubs, scratchStubs, stubWrites, workspaceNameProblem, gitInitWanted, TEMPLATE_TEXT, isTemplateText,
  workspacePlace, placeOf, resolvePlace, isContextPlace, vaultPlace, homePlace, parseRepoLink, withRepoLink, repoValue,
  termHostChoices, quickHost, launchLine, launchArgs, launchIds, previewLine, SCRATCH, menuRows, firstActionable,
} from "./terminalLaunch";
import type { PlaceWorld } from "./terminalLaunch";
import type { AgenticosJson, ProviderState } from "./aosConfig";

const req = createRequire(__filename);
const cli = req(path.resolve(__dirname, "../../../cli/workspace.js")) as {
  slugify(n: string): string; stubs(s: string): Record<string, string>; RESERVED: Set<string>;
};

// ── the port of cli/workspace.js ──

test("slugify matches the CLI", () => {
  for (const name of ["Tide chart", "  My Project!! ", "a/b\\c", "ÜBER app", "---", "", "x_y.z", "2026 plan"]) {
    assert.equal(slugify(name), cli.slugify(name), name);
  }
});

test("the stubs are byte-identical to aos workspace new", () => {
  for (const slug of ["tide-chart", "a", "bz-wedding"]) assert.deepEqual(workspaceStubs(slug), cli.stubs(slug));
});

test("reserved names match the CLI's list and rules", () => {
  assert.deepEqual([...cli.RESERVED].sort(), ["_archive", "research"]);
  assert.equal(isReserved("research", "research"), true);
  assert.equal(isReserved("Archive", "archive"), true); // '_' + slug
  assert.equal(isReserved("_archive", "archive"), true);
  assert.equal(isReserved("research notes", "research-notes"), false);
});

test("workspaceNameProblem: empty is fine (nothing typed yet), symbols only and reserved are refused", () => {
  assert.equal(workspaceNameProblem(""), null);
  assert.equal(workspaceNameProblem("!!"), "Use a letter or digit");
  assert.match(workspaceNameProblem("Research") ?? "", /reserved: try research-notes/);
  assert.equal(workspaceNameProblem("Tide chart"), null);
});

test("scratch's stubs explain Scratch and keep both instruction files identical", () => {
  const s = scratchStubs();
  assert.match(s["README.md"], /^# Scratch/);
  assert.equal(s["CLAUDE.md"], s["AGENTS.md"]);
  assert.match(s["CLAUDE.md"], /Make this a workspace/);
  assert.match(s["CLAUDE.md"], /workspaces\/scratch\//);
});

test("stubWrites follows completeStubs: mirror a lone instruction file, then write what is missing", () => {
  const stubs = workspaceStubs("kite");
  const all = stubWrites(stubs, () => false, () => "");
  assert.deepEqual(all.map((w) => w.name), ["README.md", "CLAUDE.md", "AGENTS.md"]);
  const mirror = stubWrites(stubs, (n) => n === "CLAUDE.md", () => "mine\n");
  assert.deepEqual(mirror, [{ name: "AGENTS.md", data: "mine\n" }, { name: "README.md", data: stubs["README.md"] }]);
  assert.deepEqual(stubWrites(stubs, () => true, () => ""), []);
});

// ── the stubs' placeholder text mirrors the runtime's list (spaces-redesign D23; the pulse-facts precedent) ──

type Collector = { TEMPLATE_TEXT: readonly string[]; isTemplateText(s: unknown): boolean };

/**
 * collectors/workspaces.js resolves a vault as it loads (lib/paths.js) and reads its brain/_index: give it an empty temp
 * vault and no agenticos.json, so this never reads the developer's own config or vault.
 */
function loadCollector(): Collector {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "aos-template-vault-"));
  fs.mkdirSync(path.join(vault, "brain", "_index"), { recursive: true });
  const saved = { vault: process.env.AOS_VAULT, config: process.env.AOS_CONFIG };
  process.env.AOS_VAULT = vault;
  process.env.AOS_CONFIG = path.join(vault, "no-agenticos.json");
  try {
    return req(path.resolve(__dirname, "../../../brain/scripts/collectors/workspaces.js")) as Collector;
  } finally {
    for (const [k, v] of [["AOS_VAULT", saved.vault], ["AOS_CONFIG", saved.config]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(vault, { recursive: true, force: true });
  }
}

/** A stub's first body line: the first line that is neither blank nor a heading, as the runtime reads a summary. */
const firstBodyLine = (text: string): string => text.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#")) ?? "";

test("TEMPLATE_TEXT is the runtime's list, and isTemplateText decides every line as the runtime does", () => {
  const runtime = loadCollector();
  assert.deepEqual([...TEMPLATE_TEXT], [...runtime.TEMPLATE_TEXT]);
  const stubs = workspaceStubs("tide-chart");
  const lines = [
    ...TEMPLATE_TEXT, firstBodyLine(stubs["README.md"]), firstBodyLine(stubs["CLAUDE.md"]),
    "This is the workspaces/a/ workspace of an AgenticOS vault.", "  One   line about what this project is.  ",
    "This is the `workspaces/a/b/` workspace of an AgenticOS vault.", "An offline harbor chart viewer.",
    "one line about what this project is.", "Says: One line about what this project is.", "", "   ", "- ",
  ];
  for (const l of lines) assert.equal(isTemplateText(l), runtime.isTemplateText(l), JSON.stringify(l));
  for (const v of [null, undefined, 3, ["One line about what this project is."]]) assert.equal(isTemplateText(v), runtime.isTemplateText(v));
});

test("every placeholder the stubs write is on the list: their first body lines, and bullets left empty", () => {
  for (const slug of ["tide-chart", "a", "bz-wedding"]) {
    const stubs = workspaceStubs(slug);
    for (const name of ["README.md", "CLAUDE.md", "AGENTS.md"]) assert.equal(isTemplateText(firstBodyLine(stubs[name])), true, `${slug}/${name}`);
    // The README's Objectives and Next step bullets are empty, which every bullet reader skips: a placeholder written
    // into them would need a TEMPLATE_TEXT entry (here and in the runtime).
    const bullets = stubs["README.md"].split("\n").filter((l) => /^\s*[-*+](\s|$)/.test(l));
    assert.deepEqual(bullets.map((b) => b.trim()), ["-", "-"], slug);
  }
  assert.equal(isTemplateText("An offline harbor chart viewer."), false);
  assert.equal(isTemplateText(firstBodyLine(scratchStubs()["README.md"])), false, "Scratch's README says what Scratch is");
});

// ── git (T7) ──

test("gitInitWanted: always outside a git vault; inside one only when workspaces/* is ignored and not taken back", () => {
  assert.equal(gitInitWanted(false, null, "kite"), true);
  assert.equal(gitInitWanted(true, null, "kite"), false);
  assert.equal(gitInitWanted(true, "brain/_index/\n", "kite"), false);
  assert.equal(gitInitWanted(true, "# projects\n/workspaces/*\n", "kite"), true);
  assert.equal(gitInitWanted(true, "workspaces/\n", "kite"), true);
  assert.equal(gitInitWanted(true, "/workspaces/*\n!/workspaces/kite\n", "kite"), false);
  assert.equal(gitInitWanted(true, "/workspaces/*\n!/workspaces/kite/\n", "kite"), false);
  assert.equal(gitInitWanted(true, "/workspaces/*\n!/workspaces/kites\n", "kite"), true);
  assert.equal(gitInitWanted(true, "/workspaces/notes.md\n", "kite"), false);
});

// ── places (T4) ──

const home = path.join(path.sep, "h");
const vault = path.join(home, "Vault");
const world: PlaceWorld = { vault, home, workspaces: ["bz-wedding", "notes-only", SCRATCH], links: { "notes-only": path.join(home, "Code", "app") } };

test("workspacePlace uses a linked code folder, and Scratch is its own kind", () => {
  assert.deepEqual(workspacePlace("bz-wedding", world), { kind: "workspace", label: "bz-wedding", dir: path.join(vault, "workspaces", "bz-wedding"), workspace: "bz-wedding" });
  assert.deepEqual(workspacePlace("notes-only", world), { kind: "workspace", label: "notes-only", dir: path.join(home, "Code", "app"), workspace: "notes-only", linked: true });
  assert.equal(workspacePlace(SCRATCH, world).kind, "scratch");
  assert.equal(workspacePlace(SCRATCH, world).label, "Scratch");
});

test("placeOf finds the longest match: a linked folder, a workspace, the vault, home, elsewhere", () => {
  assert.equal(placeOf(path.join(home, "Code", "app", "src"), world).workspace, "notes-only");
  assert.equal(placeOf(path.join(home, "Code", "app"), world).linked, true);
  assert.equal(placeOf(path.join(vault, "workspaces", "bz-wedding", "sub"), world).label, "bz-wedding");
  assert.equal(placeOf(path.join(vault, "workspaces", "notes-only"), world).workspace, "notes-only");
  assert.equal(placeOf(path.join(vault, "workspaces", SCRATCH), world).kind, "scratch");
  assert.equal(placeOf(path.join(vault, "workspaces", "_worktrees", "x"), world).kind, "vault");
  assert.equal(placeOf(vault, world).kind, "vault");
  assert.equal(placeOf(home, world).kind, "home");
  const other = placeOf(path.join(home, "elsewhere", "proj"), world);
  assert.deepEqual([other.kind, other.label], ["other", "proj"]);
});

test("only a workspace counts as context: never Scratch, the vault or home", () => {
  assert.equal(isContextPlace(workspacePlace("bz-wedding", world)), true);
  assert.equal(isContextPlace(workspacePlace(SCRATCH, world)), false);
  assert.equal(isContextPlace(vaultPlace(world)), false);
  assert.equal(isContextPlace(homePlace(world)), false);
  assert.equal(isContextPlace(null), false);
});

test("resolvePlace: picked, then a workspace in view, then the vault (or the choice) per host", () => {
  const base = { scratch: workspacePlace(SCRATCH, world), vault: vaultPlace(world), shellDefault: vaultPlace(world), agentPlace: "vault" as const };
  const ws = workspacePlace("bz-wedding", world);
  assert.deepEqual(resolvePlace({ ...base, host: "claude", picked: ws, context: base.scratch }), { place: ws, why: "picked" });
  assert.deepEqual(resolvePlace({ ...base, host: "codex", context: ws }), { place: ws, why: "context" });
  assert.deepEqual(resolvePlace({ ...base, host: "shell", context: ws }), { place: ws, why: "context" });
  // a selected Vault row (a skill run) never pulls an agent into the vault root
  assert.deepEqual(resolvePlace({ ...base, host: "claude", context: vaultPlace(world) }), { place: base.vault, why: "default" });
  // A selected Scratch terminal does not pull the next one into Scratch.
  assert.deepEqual(resolvePlace({ ...base, host: "codex", context: base.scratch }), { place: base.vault, why: "default" });
  assert.deepEqual(resolvePlace({ ...base, host: "shell", context: base.scratch }), { place: base.shellDefault, why: "default" });
  assert.deepEqual(resolvePlace({ ...base, host: "shell" }), { place: base.shellDefault, why: "default" });
  assert.deepEqual(resolvePlace({ ...base, host: "claude" }).place, base.vault);
  assert.deepEqual(resolvePlace({ ...base, host: "claude", agentPlace: "scratch" }).place, base.scratch);
  assert.deepEqual(resolvePlace({ ...base, host: "claude", agentPlace: "last", lastWorkspace: ws }).place, ws);
  assert.deepEqual(resolvePlace({ ...base, host: "claude", agentPlace: "last", lastWorkspace: null }).place, base.vault);
});

// ── linked code folders (T8) ──

test("parseRepoLink reads repo: from the frontmatter, expands ~, and refuses relative or in-vault paths", () => {
  assert.equal(parseRepoLink("---\nstatus: active\nrepo: ~/Code/app\n---\n# x\n", home, vault), path.join(home, "Code", "app"));
  assert.equal(parseRepoLink('---\nrepo: "/opt/src/app"\n---\n', home, vault), path.resolve("/opt/src/app"));
  assert.equal(parseRepoLink("---\nrepo: Code/app\n---\n", home, vault), null);
  assert.equal(parseRepoLink(`---\nrepo: ${path.join(vault, "workspaces", "x")}\n---\n`, home, vault), null);
  assert.equal(parseRepoLink("# no frontmatter\nrepo: ~/x\n", home, vault), null);
  assert.equal(parseRepoLink(null, home, vault), null);
});

test("withRepoLink adds, replaces and removes the key and keeps the rest", () => {
  assert.equal(withRepoLink(null, "~/Code/app"), '---\nrepo: "~/Code/app"\n---\n');
  assert.equal(withRepoLink("# Notes\n", "~/x"), '---\nrepo: "~/x"\n---\n# Notes\n');
  assert.equal(withRepoLink("---\nstatus: active\nrepo: ~/old\n---\nbody\n", "~/new"), '---\nstatus: active\nrepo: "~/new"\n---\nbody\n');
  assert.equal(withRepoLink("---\nstatus: active\nrepo: ~/old\n---\nbody\n", null), "---\nstatus: active\n---\nbody\n");
  assert.equal(withRepoLink("---\nrepo: ~/old\n---\nbody\n", null), "body\n");
  assert.equal(parseRepoLink(withRepoLink("x", repoValue(path.join(home, "Code", "app"), home)), home, vault), path.join(home, "Code", "app"));
});

test("repoValue writes ~ under home and the absolute path elsewhere", () => {
  assert.equal(repoValue(path.join(home, "Code", "app"), home), "~/Code/app");
  assert.equal(repoValue(path.resolve("/opt/src"), home), path.resolve("/opt/src"));
});

// ── hosts (T2) ──

const both: AgenticosJson = { hosts: { claude: { enabled: true, bin: "/opt/bin/claude" }, codex: { enabled: true } }, codex: { bin: "/opt/bin/codex" } };
const codexOnly: AgenticosJson = { hosts: { claude: { enabled: false }, codex: { enabled: true } } };
const claudeOut: ProviderState = { checkedAt: "", name: "codex", reason: "", claude: { loggedIn: false, checkedAt: "" } };

test("termHostChoices: hides hosts that are off, keeps logged-out ones with why, records the binary, always has Shell", () => {
  const all = termHostChoices(both, null);
  assert.deepEqual(all.map((c) => [c.host, c.hidden, c.ready, c.bin]), [["claude", false, true, "/opt/bin/claude"], ["codex", false, true, "/opt/bin/codex"], ["shell", false, true, null]]);
  const co = termHostChoices(codexOnly, null);
  assert.equal(co[0].hidden, true);
  const out = termHostChoices(both, claudeOut);
  assert.deepEqual([out[0].ready, out[0].reason], [false, "Claude Code is not logged in"]);
});

test("quickHost: the remembered host; else the first ready agent; never another host when the remembered one is not ready", () => {
  assert.deepEqual(quickHost("codex", termHostChoices(both, null)), { host: "codex", reason: null });
  assert.deepEqual(quickHost(null, termHostChoices(both, null)), { host: "claude", reason: null });
  assert.deepEqual(quickHost(null, termHostChoices(codexOnly, null)), { host: "codex", reason: null });
  assert.deepEqual(quickHost("claude", termHostChoices(both, claudeOut)), { host: null, reason: "Claude Code is not logged in" });
  assert.deepEqual(quickHost("shell", termHostChoices(both, claudeOut)), { host: "shell", reason: null });
  // a remembered host that was switched off since: back to the first ready one
  assert.deepEqual(quickHost("claude", termHostChoices(codexOnly, null)), { host: "codex", reason: null });
  assert.deepEqual(quickHost(null, termHostChoices({ hosts: {} }, null)), { host: "shell", reason: null });
});

// ── the launch line (T10, T11) ──

test("launchArgs per host and access level; Host default passes no flags", () => {
  assert.deepEqual(launchArgs({ host: "claude", bin: null, model: null, access: "host", sessionId: "u1" }), ["--session-id", "u1"]);
  assert.deepEqual(launchArgs({ host: "claude", bin: null, model: "opus", access: "read" }), ["--model", "opus", "--permission-mode", "plan"]);
  assert.deepEqual(launchArgs({ host: "claude", bin: null, model: null, access: "edit" }), ["--permission-mode", "acceptEdits"]);
  assert.deepEqual(launchArgs({ host: "claude", bin: null, model: null, access: "run" }), ["--permission-mode", "acceptEdits", "--allowedTools", "Bash"]);
  assert.deepEqual(launchArgs({ host: "claude", bin: null, model: null, access: "host", resume: "last" }), ["--continue"]);
  assert.deepEqual(launchArgs({ host: "claude", bin: null, model: null, access: "host", resume: { id: "u2" }, sessionId: "u3" }), ["--resume", "u2"]);
  assert.deepEqual(launchArgs({ host: "codex", bin: null, model: null, access: "host" }), []);
  assert.deepEqual(launchArgs({ host: "codex", bin: null, model: "gpt-6-sol", access: "read" }), ["-m", "gpt-6-sol", "-s", "read-only", "-a", "on-request"]);
  assert.deepEqual(launchArgs({ host: "codex", bin: null, model: null, access: "edit" }), ["-s", "workspace-write", "-a", "on-request"]);
  assert.deepEqual(launchArgs({ host: "codex", bin: null, model: "x", access: "edit", resume: "last" }), ["resume", "--last"]);
});

test("a Spaces resume by id: codex resume <id> names the terminal's folder first with -C, so Codex does not ask (spaces-redesign D7)", () => {
  const id = "019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b";
  const dir = path.join(vault, "workspaces", "bz-wedding");
  assert.deepEqual(launchArgs({ host: "codex", bin: null, model: null, access: "host", resume: { id }, cwd: dir }), ["resume", "-C", dir, id]);
  // The model and access of a new session are not passed to a resume: the thread keeps its own settings.
  assert.deepEqual(launchArgs({ host: "codex", bin: null, model: "gpt-6-sol", access: "edit", resume: { id }, cwd: dir }), ["resume", "-C", dir, id]);
  assert.equal(
    launchLine({ host: "codex", bin: null, model: null, access: "host", resume: { id }, cwd: dir }),
    ` command -v 'codex' >/dev/null 2>&1 && exec 'codex' resume -C ${dir} ${id} || echo 'Codex was not found: run aos doctor'`,
  );
  // A folder with a space is quoted; with no folder the line is the plain resume (Codex then asks which folder).
  assert.match(launchLine({ host: "codex", bin: null, model: null, access: "host", resume: { id }, cwd: path.join(home, "My Code", "app") }), /resume -C '[^']*My Code[^']*' [0-9a-f-]+ \|\|/);
  assert.deepEqual(launchArgs({ host: "codex", bin: null, model: null, access: "host", resume: { id } }), ["resume", id]);
  // --last needs no folder: it only looks at threads recorded in this one.
  assert.deepEqual(launchArgs({ host: "codex", bin: null, model: null, access: "host", resume: "last", cwd: dir }), ["resume", "--last"]);
  // Claude Code finds a thread from any folder (D7's build check): no flag for the folder.
  assert.deepEqual(launchArgs({ host: "claude", bin: null, model: null, access: "host", resume: { id }, cwd: dir }), ["--resume", id]);
  assert.equal(previewLine({ host: "codex", bin: null, model: null, access: "host", resume: { id }, cwd: dir }), `exec codex resume -C ${dir} ${id}`);
});

test("launchIds: the terminal keeps the conversation's id on either host when it is known, for the end bar's Resume", () => {
  const mint = () => "11111111-2222-4333-a444-555555555555";
  const id = "019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b";
  // a new Claude Code conversation gets an id up front (--session-id) and keeps it
  assert.deepEqual(launchIds("claude", null, mint), { fresh: mint(), known: mint() });
  // any resume by id keeps that id, Codex included (spaces-redesign D7); nothing new is minted
  assert.deepEqual(launchIds("claude", { id }, mint), { fresh: null, known: id });
  assert.deepEqual(launchIds("codex", { id }, mint), { fresh: null, known: id });
  // a new Codex session and a resume of the latest know no id: the end bar offers Resume latest
  assert.deepEqual(launchIds("codex", null, mint), { fresh: null, known: null });
  assert.deepEqual(launchIds("claude", "last", mint), { fresh: null, known: null });
  assert.deepEqual(launchIds("codex", "last", mint), { fresh: null, known: null });
  assert.deepEqual(launchIds("shell", { id }, mint), { fresh: null, known: null });
});

test("launchArgs refuses a free value that starts with '-': a model, an id or a folder never reads as a flag", () => {
  const base = { bin: null, access: "host" as const };
  const bad: Array<Parameters<typeof launchArgs>[0]> = [
    { ...base, host: "claude", model: null, resume: { id: "--dangerously-skip-permissions" } },
    { ...base, host: "codex", model: null, resume: { id: "-c" } },
    { ...base, host: "claude", model: "--allowedTools", resume: null },
    { ...base, host: "codex", model: "-s", resume: null },
    { ...base, host: "claude", model: null, sessionId: "-x" },
    { ...base, host: "codex", model: null, resume: { id: "019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b" }, cwd: "--add-dir" },
  ];
  for (const s of bad) {
    assert.throws(() => launchArgs(s), /starts with "-"/, JSON.stringify(s));
    assert.throws(() => launchLine(s), /starts with "-"/, JSON.stringify(s));
  }
  // A dash inside a value is fine (ids, models).
  assert.deepEqual(launchArgs({ ...base, host: "claude", model: "claude-opus-5", resume: { id: "3f2c-1" } }), ["--model", "claude-opus-5", "--resume", "3f2c-1"]);
});

test("launchArgs refuses a free value holding a control character: a scanned folder named with ^U never reaches the shell", () => {
  const base = { bin: null, access: "host" as const };
  const id = "019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b";
  const bad: Array<Parameters<typeof launchArgs>[0]> = [
    // ^U kills the typed line in a shell, so a folder carrying it could type its own command after it.
    { ...base, host: "codex", model: null, resume: { id }, cwd: "/tmp/x\u0015rm -rf ~\u0015" },
    { ...base, host: "codex", model: null, resume: { id }, cwd: "/tmp/new\nline" },
    { ...base, host: "codex", model: null, resume: { id }, cwd: "/tmp/del\u007f" },
    { ...base, host: "claude", model: "opus\u0003", resume: null },
    { ...base, host: "claude", model: null, resume: { id: `${id}\r` } },
    { ...base, host: "claude", model: null, sessionId: "u1\u001b[2J" },
  ];
  for (const s of bad) {
    assert.throws(() => launchArgs(s), /control character/, JSON.stringify(s));
    assert.throws(() => launchLine(s), /control character/, JSON.stringify(s));
  }
  // A space, a quote or a non-ASCII letter in a folder is fine: launchLine quotes it.
  assert.deepEqual(launchArgs({ ...base, host: "codex", model: null, resume: { id }, cwd: "/tmp/My Ré'sumé" }), ["resume", "-C", "/tmp/My Ré'sumé", id]);
});

test("launchLine: leading space, the not-found guard, exec, quoting of the binary and of glob-like ids", () => {
  const line = launchLine({ host: "claude", bin: "/opt/my apps/claude", model: "claude-opus-5[1m]", access: "host", sessionId: "3f2c-1" });
  assert.equal(line, " command -v '/opt/my apps/claude' >/dev/null 2>&1 && exec '/opt/my apps/claude' --model 'claude-opus-5[1m]' --session-id 3f2c-1 || echo 'Claude Code was not found: run aos doctor'");
  const codex = launchLine({ host: "codex", bin: null, model: null, access: "host", gitInit: true, envPrefix: "CODEX_HOME='/x' " });
  assert.equal(codex, " [ -e .git ] || git init -q; command -v 'codex' >/dev/null 2>&1 && CODEX_HOME='/x' exec 'codex' || echo 'Codex was not found: run aos doctor'");
});

test("previewLine is the short form the menu shows", () => {
  assert.equal(previewLine({ host: "claude", bin: "/a/claude", model: "opus", access: "host", sessionId: "3f2c9d" }), "exec claude --model opus --session-id 3f2c…");
  assert.equal(previewLine({ host: "codex", bin: null, model: null, access: "edit", gitInit: true }), "git init -q; exec codex -s workspace-write -a on-request");
});

// ── the New menu (T3, T6) ──

test("menuRows with no query: Start now per host that is on, then the places, recent, workspaces, New workspace", () => {
  const rows = menuRows({ query: "", host: "claude", choices: termHostChoices(codexOnly, null), world, context: workspacePlace("bz-wedding", world), recent: ["notes-only", "gone"], nowSub: (h) => `sub ${h}` });
  assert.deepEqual(rows.filter((r) => r.kind === "now").map((r) => [r.host, r.kbd, r.sub]), [["codex", "⌥⌘2", "sub codex"], ["shell", "⌥⌘3", "sub shell"]]);
  assert.deepEqual(rows.filter((r) => r.kind !== "now").map((r) => r.key),
    ["h-now", "h-in", "same", "vault", "scratch", "h-recent", "recent-notes-only", "h-ws", "ws-bz-wedding", "ws-notes-only", "new"]);
  assert.match(rows.find((r) => r.key === "vault")?.sub ?? "", /when nothing is picked/);
  // A selected Scratch terminal is not "Same as selected": Scratch is in the list already.
  assert.equal(menuRows({ query: "", host: "claude", choices: termHostChoices(codexOnly, null), world, context: workspacePlace(SCRATCH, world), recent: [], nowSub: () => "" }).some((r) => r.key === "same"), false);
  assert.equal(rows.find((r) => r.key === "ws-notes-only")?.sub, `code: ${path.join(home, "Code", "app")}`);
  assert.equal(firstActionable(rows)?.key, "now-codex");
  // Home is a shell's place only; a logged-out host is listed but cannot be picked
  assert.ok(menuRows({ query: "", host: "shell", choices: termHostChoices(both, claudeOut), world, context: null, recent: [], nowSub: () => "" }).some((r) => r.key === "home"));
  assert.equal(menuRows({ query: "", host: "codex", choices: termHostChoices(both, claudeOut), world, context: null, recent: [], nowSub: () => "" }).find((r) => r.key === "now-claude")?.disabled, true);
});

test("menuRows with a query: an exact name starts there; anything else creates first, with near misses below", () => {
  const base = { host: "codex" as const, choices: termHostChoices(both, null), world, context: null, recent: [], nowSub: () => "" };
  const exact = menuRows({ ...base, query: "BZ Wedding" });
  assert.equal(firstActionable(exact)?.key, "ws-bz-wedding");
  const near = menuRows({ ...base, query: "wedding" });
  assert.equal(firstActionable(near)?.kind, "create");
  assert.equal(firstActionable(near)?.label, "Create workspaces/wedding and start Codex");
  assert.ok(near.some((r) => r.key === "ws-bz-wedding"));
  assert.equal(firstActionable(menuRows({ ...base, query: "scratch" }))?.key, "scratch");
  const reserved = menuRows({ ...base, query: "research" });
  assert.deepEqual([reserved[0].kind, reserved[0].disabled], ["create", true]);
  assert.equal(menuRows({ ...base, host: "shell", query: "kite" })[0].label, "Create workspaces/kite and open a shell");
});
