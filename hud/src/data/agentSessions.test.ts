import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACCESS_LEVELS, CODEX_ACCESS_NOTE, DEFAULT_ACCESS, EFFORT_TITLE, SESSION_EFFORTS, VAULT_EFFORTS, accessHostLine, accessLabel,
  catalogHost, catalogSource, chipText, choiceText, commandQuery, commandTyping, countsText, defaultChoice, diffTotals,
  doneFooter, doneLine, durationText, effortLabel, effortsFor, fileCounts, fileStatusLabel, filterCommands, findModel, groupThreads,
  hostChoices, isAccess, lastTurnUsd, mergeEvents, modelArg, modelName, relPath, searchModels, sessionSpendToday, spendLine, splitModels, statusSummary, threadAge,
  threadMeta, threadRows, timelineRows, toolCallLine, toolLine, toolResultText, turnChoices, turnElapsed, turnOpen, usdText,
  workingText, workspaceNames, type CatalogCommand, type ThreadRow, type ToolCall,
} from "./agentSessions";
import type { HostCatalog, HostCatalogHost, HostGitStatus, HostSessionEvent, HostSessionThread } from "../host";

const thread = (id: string, workspace: string, updated: string, extra: Partial<HostSessionThread> = {}): HostSessionThread => ({
  id, workspace, host: "claude", model: null, effort: null, access: "edit", title: id, created: updated, updated, turns: 1, running: false, usd: 0, ...extra,
});
const ev = (kind: HostSessionEvent["kind"], turn: number, fields: Record<string, unknown> = {}): HostSessionEvent => ({ t: "2026-10-07T10:00:00.000Z", kind, turn, ...fields });

test("workspaceNames: plain folder names, sorted; hidden folders and the team worktrees are left out", () => {
  assert.deepEqual(workspaceNames(["tide", ".git", "_worktrees", "harbor-map", ""]), ["harbor-map", "tide"]);
  assert.deepEqual(workspaceNames([]), []);
});

test("groupThreads: by workspace, newest first within each, the workspace with the newest thread first", () => {
  const groups = groupThreads([
    thread("a", "harbor-map", "2026-10-07T09:00:00Z"),
    thread("b", "tide", "2026-10-07T11:00:00Z"),
    thread("c", "harbor-map", "2026-10-07T10:00:00Z"),
  ]);
  assert.deepEqual(groups.map((g) => [g.workspace, g.threads.map((t) => t.id)]), [["tide", ["b"]], ["harbor-map", ["c", "a"]]]);
  assert.deepEqual(groupThreads([]), []);
});

test("threadMeta and usdText: turns, then the spend (Codex's marked as an estimate)", () => {
  assert.equal(threadMeta(thread("a", "w", "x")), "1 turn");
  assert.equal(threadMeta(thread("a", "w", "x", { turns: 2, usd: 0.04 })), "2 turns · $0.04");
  assert.equal(threadMeta(thread("a", "w", "x", { host: "codex", turns: 3, usd: 0.0012 })), "3 turns · ≈$0.0012");
  assert.equal(usdText(0), "$0.00");
  assert.equal(usdText(1.5), "$1.50");
});

test("toolLine: kind · name · file, with the parts that are missing left out", () => {
  assert.equal(toolLine({ toolKind: "edit", name: "Edit", filePath: "src/a.js", summary: "" }), "edit · Edit · src/a.js");
  assert.equal(toolLine({ toolKind: "bash", name: "shell", filePath: null, summary: "npm test" }), "bash · shell");
  assert.equal(toolLine({ toolKind: "", name: "Task", filePath: null, summary: "" }), "other · Task");
});

test("timelineRows: prompts, text, a tool with its result folded in, files, errors, and a footer per turn; the session id is left out", () => {
  const rows = timelineRows([
    ev("prompt", 1, { text: "fix the parser" }),
    ev("session", 1, { id: "abc" }),
    ev("text", 1, { text: "Fixed." }),
    ev("tool", 1, { id: "t1", name: "Edit", toolKind: "edit", summary: "{\"file_path\":\"src/a.js\"}", filePath: "src/a.js" }),
    ev("tool", 1, { id: "t2", name: "Bash", toolKind: "bash", summary: "npm test", filePath: null }),
    ev("tool_result", 1, { id: "t1", ok: true, summary: "ok" }),
    ev("tool_result", 1, { id: "t2", ok: false, summary: "1 failing" }),
    ev("usage", 1, { in: 1200, out: 45, usd: 0.02, estimated: false }),
    ev("done", 1, { ok: true, usd: 0.02, estimated: false }),
    ev("prompt", 2, { text: "go" }),
    ev("patch", 2, { files: [{ path: "src/b.js", change: "add" }] }),
    ev("error", 2, { message: "stopped" }),
    ev("done", 2, { ok: false, usd: null, estimated: true }),
  ]);
  assert.deepEqual(rows.map((r) => r.kind), ["prompt", "text", "tool", "tool", "done", "prompt", "patch", "error", "done"]);
  const [edit, bash] = rows.filter((r) => r.kind === "tool");
  assert.ok(edit.kind === "tool" && bash.kind === "tool");
  assert.deepEqual(edit.result, { ok: true, summary: "ok" });
  assert.equal(edit.tool.filePath, "src/a.js");
  assert.deepEqual(bash.result, { ok: false, summary: "1 failing" });
  assert.notEqual(edit.key, bash.key);
  const dones = rows.filter((r) => r.kind === "done");
  assert.deepEqual(dones.map((d) => d.kind === "done" && [d.ok, d.footer]), [[true, "$0.02 · 1,200 in · 45 out"], [false, "did not finish · no cost recorded"]]);
  const patch = rows.find((r) => r.kind === "patch");
  assert.deepEqual(patch && patch.kind === "patch" && patch.files, [{ path: "src/b.js", change: "add" }]);
});

test("timelineRows: a tool still waiting has no result; a result of an unknown tool is dropped", () => {
  const rows = timelineRows([ev("prompt", 1, { text: "x" }), ev("tool", 1, { id: "t1", name: "Read", toolKind: "read" }), ev("tool_result", 1, { id: "nope", ok: true })]);
  assert.deepEqual(rows.map((r) => r.kind), ["prompt", "tool"]);
  assert.equal(rows[1].kind === "tool" && rows[1].result, null);
});

test("doneFooter: a Codex turn's cost is an estimate; a missing usage still gives the cost", () => {
  assert.equal(doneFooter(ev("done", 1, { ok: true, usd: 0.0012, estimated: true }), ev("usage", 1, { in: 1200, out: 80 })), "$0.0012 estimated · 1,200 in · 80 out");
  assert.equal(doneFooter(ev("done", 1, { ok: true, usd: 0.5, estimated: false }), null), "$0.50");
});

test("turnOpen: a prompt with no done after it", () => {
  assert.equal(turnOpen([]), false);
  assert.equal(turnOpen([ev("prompt", 1)]), true);
  assert.equal(turnOpen([ev("prompt", 1), ev("text", 1)]), true);
  assert.equal(turnOpen([ev("prompt", 1), ev("done", 1)]), false);
  assert.equal(turnOpen([ev("prompt", 1), ev("done", 1), ev("prompt", 2)]), true);
});

test("mergeEvents: the read and the live events overlap; each record appears once, in order", () => {
  const a = ev("prompt", 1, { text: "x" });
  const b = ev("text", 1, { text: "y" });
  const c = ev("done", 1, { ok: true });
  assert.deepEqual(mergeEvents([a, b], [b, c]), [a, b, c]);
  assert.deepEqual(mergeEvents([], [a, a]), [a]);
});

test("fileStatusLabel and statusSummary: the card's words for git's codes", () => {
  assert.deepEqual(["??", ".M", "M.", "A.", ".D", "R.", "UU", "AA"].map(fileStatusLabel), ["new", "modified", "modified", "added", "deleted", "renamed", "conflict", "conflict"]);
  const st = { repo: true, branch: "main", detached: false, merging: false, files: [] as HostGitStatus["files"] };
  const f = (path: string, status: string) => ({ path, status, added: null, removed: null });
  assert.equal(statusSummary(st), "No changes");
  assert.equal(statusSummary({ ...st, files: [f("a", "??")] }), "1 file changed");
  assert.equal(statusSummary({ ...st, files: [f("a", "??"), f("b", ".M")] }), "2 files changed");
  assert.equal(statusSummary({ ...st, repo: false }), "Not a git repository");
});

test("hostChoices: both hosts in order; one that is off or not logged in is offered disabled, with why", () => {
  const both = { hosts: { claude: { enabled: true }, codex: { enabled: true } } };
  assert.deepEqual(hostChoices(both, null).map((c) => [c.host, c.ready]), [["claude", true], ["codex", true]]);
  const codexOnly = hostChoices({ hosts: { claude: { enabled: false }, codex: { enabled: true } } }, null);
  assert.deepEqual(codexOnly.map((c) => [c.host, c.ready, c.reason]), [["claude", false, "Claude Code is off on this machine"], ["codex", true, null]]);
  // A config written before hosts existed is Claude only.
  assert.deepEqual(hostChoices({}, null).map((c) => c.ready), [true, false]);
  const loggedOut = hostChoices(both, { checkedAt: "", name: "claude", reason: "", claude: { loggedIn: false, checkedAt: "" } });
  assert.deepEqual(loggedOut.map((c) => c.reason), ["Claude Code is not logged in", null]);
});

// ── the host catalog ──

const E5 = ["low", "medium", "high", "xhigh", "max"];
const E6 = ["low", "medium", "high", "xhigh", "max", "ultra"];
const model = (id: string, name: string, efforts: string[], main: boolean, description = "") => ({ id, name, description, efforts, main });
const claudeCat: HostCatalogHost = {
  ok: true, version: "2.1.293", fetchedAt: "2026-10-07T09:58:00.000Z", defaultModel: null, defaultEffort: null,
  models: [
    model("default", "Default (recommended)", E5, true, "Opus 5.5 · Best for everyday, complex tasks"),
    model("opus", "Opus 5.5", E5, true, "For complex work and everyday tasks"),
    model("haiku", "Haiku 5.5", E5, true, "Fastest for quick answers"),
    model("claude-opus-4-6", "Opus 4.6", ["low", "medium", "high", "max"], false),
    model("claude-haiku-4-5-20251001", "Haiku 4.5", [], false),
  ],
  commands: [],
};
const codexCat: HostCatalogHost = {
  ok: true, version: "0.158.0", fetchedAt: "2026-10-07T09:00:00.000Z", defaultModel: "gpt-6-sol", defaultEffort: "high",
  models: [
    model("gpt-6-astra", "GPT-6-Astra", E6, true, "Frontier intelligence for the most demanding work"),
    model("gpt-6-sol", "GPT-6-Sol", ["minimal", ...E6], true, "Previous generation workhorse model"),
    model("gpt-6-luna", "GPT-6-Luna", E5, true),
    model("gpt-5.6-terra", "GPT-5.6-Terra", ["high", "max"], false, "Older balanced model"),
  ],
  commands: [],
};
/** A Codex that did not answer and has no configured default: no models at all (the runtime's FALLBACK). */
const codexDown: HostCatalogHost = { ok: false, reason: "Codex listed no models", version: null, fetchedAt: "2026-10-07T09:00:00.000Z", defaultModel: null, defaultEffort: null, models: [], commands: [] };
/** A Claude that did not answer: its aliases, all current. */
const claudeDown: HostCatalogHost = { ...claudeCat, ok: false, reason: "Claude Code did not answer in 20 s", version: null, models: claudeCat.models.slice(0, 3).map((m) => ({ ...m, name: m.id === "default" ? "Default" : m.name.split(" ")[0] })) };
const NOW = new Date("2026-10-07T10:00:00.000Z");

test("effortLabel and the effort lists: every level in words; Vault's levels are the one-shot paths'", () => {
  assert.deepEqual(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"].map(effortLabel), ["Minimal", "Low", "Medium", "High", "XHigh", "Max", "Ultra"]);
  assert.equal(effortLabel("turbo"), "Turbo");
  assert.equal(effortLabel(""), "");
  assert.deepEqual(SESSION_EFFORTS.claude, E5);
  assert.deepEqual(VAULT_EFFORTS.codex, ["minimal", "low", "medium", "high", "xhigh"]);
  assert.deepEqual(EFFORT_TITLE, { claude: "Effort", codex: "Reasoning" });
});

test("catalogHost and splitModels: current models, then the older ones; nothing for a host the catalog lacks", () => {
  const cat: HostCatalog = { schema: 1, fetchedAt: NOW.toISOString(), hosts: { claude: claudeCat } };
  assert.equal(catalogHost(cat, "claude"), claudeCat);
  assert.equal(catalogHost(cat, "codex"), null);
  assert.equal(catalogHost(null, "claude"), null);
  const c = splitModels(claudeCat);
  assert.deepEqual(c.current.map((m) => m.id), ["default", "opus", "haiku"]);
  assert.deepEqual(c.older.map((m) => m.id), ["claude-opus-4-6", "claude-haiku-4-5-20251001"]);
  assert.deepEqual(splitModels(codexCat).older.map((m) => m.id), ["gpt-5.6-terra"]);
  assert.deepEqual(splitModels(null), { current: [], older: [] });
  assert.deepEqual(splitModels(codexDown), { current: [], older: [] });
  assert.deepEqual(splitModels(claudeDown).older, []);
  assert.equal(findModel(claudeCat, "opus")?.name, "Opus 5.5");
  assert.equal(findModel(claudeCat, null), null);
  assert.equal(findModel(null, "opus"), null);
});

test("modelName: a listed model by name (without '(recommended)'); no model or Claude's default alias is Default; a custom id shows itself", () => {
  assert.equal(modelName("claude", claudeCat, "opus"), "Opus 5.5");
  assert.equal(modelName("claude", claudeCat, "default"), "Default");
  assert.equal(modelName("claude", claudeCat, null), "Default");
  assert.equal(modelName("claude", null, "default"), "Default");
  assert.equal(modelName("claude", claudeDown, "default"), "Default");
  assert.equal(modelName("claude", claudeCat, "claude-opus-5-5[1m]"), "claude-opus-5-5[1m]");
  assert.equal(modelName("codex", codexCat, "gpt-6-sol"), "GPT-6-Sol");
  assert.equal(modelName("codex", codexCat, null), "Codex default");
  assert.equal(modelName("codex", codexDown, "gpt-7-preview"), "gpt-7-preview");
  // "default" is only Claude's alias; on Codex it is just an id.
  assert.equal(modelName("codex", codexCat, "default"), "default");
});

test("effortsFor: the model's own levels; none for a model without efforts; a custom id gets the host's; Vault keeps only its path's", () => {
  assert.deepEqual(effortsFor("claude", claudeCat, "opus"), E5);
  assert.deepEqual(effortsFor("claude", claudeCat, "claude-opus-4-6"), ["low", "medium", "high", "max"]);
  assert.deepEqual(effortsFor("claude", claudeCat, "claude-haiku-4-5-20251001"), []);
  assert.deepEqual(effortsFor("claude", claudeCat, "claude-custom-9"), SESSION_EFFORTS.claude);
  assert.deepEqual(effortsFor("claude", claudeCat, null), E5, "no model is the default alias");
  assert.deepEqual(effortsFor("claude", null, "opus"), SESSION_EFFORTS.claude, "an empty catalog");
  assert.deepEqual(effortsFor("codex", codexCat, "gpt-6-astra"), E6);
  assert.deepEqual(effortsFor("codex", codexCat, null), ["minimal", ...E6], "no model is Codex's configured default");
  assert.deepEqual(effortsFor("codex", codexDown, null), SESSION_EFFORTS.codex);
  // Vault: Claude's five all pass; Codex drops max and ultra.
  assert.deepEqual(effortsFor("claude", claudeCat, "opus", true), E5);
  assert.deepEqual(effortsFor("codex", codexCat, "gpt-6-astra", true), ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(effortsFor("codex", codexCat, "gpt-5.6-terra", true), ["high"]);
  assert.deepEqual(effortsFor("codex", codexDown, "anything", true), VAULT_EFFORTS.codex);
  assert.deepEqual(effortsFor("claude", claudeCat, "claude-haiku-4-5-20251001", true), []);
  // The catalog's list is never handed out to be changed.
  effortsFor("claude", claudeCat, "opus").push("x");
  assert.deepEqual(claudeCat.models[1].efforts, E5);
});

test("defaultChoice on Claude: the remembered model, else default; the remembered effort only when the model takes it", () => {
  assert.deepEqual(defaultChoice("claude", claudeCat, null), { model: "default", effort: "medium" });
  assert.deepEqual(defaultChoice("claude", claudeCat, { model: "opus", effort: "max" }), { model: "opus", effort: "max" });
  assert.deepEqual(defaultChoice("claude", claudeCat, { model: "claude-opus-4-6", effort: "xhigh" }), { model: "claude-opus-4-6", effort: "medium" });
  assert.deepEqual(defaultChoice("claude", claudeCat, { model: "claude-haiku-4-5-20251001", effort: "high" }), { model: "claude-haiku-4-5-20251001", effort: null });
  assert.deepEqual(defaultChoice("claude", claudeCat, { model: "my-custom", effort: "xhigh" }), { model: "my-custom", effort: "xhigh" });
  assert.deepEqual(defaultChoice("claude", null, { effort: "high" }), { model: "default", effort: "high" });
  assert.deepEqual(defaultChoice("claude", claudeDown, {}), { model: "default", effort: "medium" });
});

test("defaultChoice on Codex: remembered, else the configured default, else the first current model; effort falls back to the catalog's, medium, the first", () => {
  assert.deepEqual(defaultChoice("codex", codexCat, null), { model: "gpt-6-sol", effort: "high" });
  assert.deepEqual(defaultChoice("codex", codexCat, { model: "gpt-6-astra", effort: "ultra" }), { model: "gpt-6-astra", effort: "ultra" });
  assert.deepEqual(defaultChoice("codex", { ...codexCat, defaultModel: null, defaultEffort: null }, null), { model: "gpt-6-astra", effort: "medium" });
  // Neither the catalog's default nor medium is taken: the model's first level.
  assert.deepEqual(defaultChoice("codex", { ...codexCat, defaultEffort: "low" }, { model: "gpt-5.6-terra" }), { model: "gpt-5.6-terra", effort: "high" });
  // A Codex that listed nothing runs its own default.
  assert.deepEqual(defaultChoice("codex", codexDown, null), { model: null, effort: "medium" });
  assert.deepEqual(defaultChoice("codex", null, null), { model: null, effort: "medium" });
  // Vault: a remembered ultra is not a level ask.js takes.
  assert.deepEqual(defaultChoice("codex", codexCat, { model: "gpt-6-astra", effort: "ultra" }, true), { model: "gpt-6-astra", effort: "high" });
});

test("modelArg: Claude's default alias and no choice pass no --model", () => {
  assert.equal(modelArg("claude", "default"), null);
  assert.equal(modelArg("claude", null), null);
  assert.equal(modelArg("claude", "opus"), "opus");
  assert.equal(modelArg("codex", "default"), "default");
  assert.equal(modelArg("codex", null), null);
});

test("chipText and choiceText: host · model · effort, with no effort part when the model takes none", () => {
  assert.equal(chipText("claude", claudeCat, "opus", "high"), "Claude Code · Opus 5.5 · High");
  assert.equal(chipText("claude", claudeCat, "default", "medium"), "Claude Code · Default · Medium");
  assert.equal(chipText("claude", claudeCat, "claude-haiku-4-5-20251001", "high"), "Claude Code · Haiku 4.5");
  assert.equal(chipText("claude", claudeCat, "opus", null), "Claude Code · Opus 5.5");
  assert.equal(chipText("codex", codexCat, "gpt-6-astra", "xhigh"), "Codex · GPT-6-Astra · XHigh");
  assert.equal(chipText("codex", codexDown, null, "medium"), "Codex · Codex default · Medium");
  assert.equal(choiceText("codex", codexCat, "gpt-6-astra", "max"), "GPT-6-Astra · Max");
  assert.equal(choiceText("codex", codexCat, "gpt-6-astra", "max", true), "GPT-6-Astra", "Vault does not take max on Codex");
});

test("searchModels: by name, id or description, ignoring case; an empty query keeps them all", () => {
  const all = codexCat.models;
  assert.deepEqual(searchModels(all, "ASTRA").map((m) => m.id), ["gpt-6-astra"]);
  assert.deepEqual(searchModels(all, "gpt-5.6").map((m) => m.id), ["gpt-5.6-terra"]);
  assert.deepEqual(searchModels(all, "workhorse").map((m) => m.id), ["gpt-6-sol"]);
  assert.deepEqual(searchModels(all, "  ").length, all.length);
  assert.deepEqual(searchModels(all, "nothing like it"), []);
  assert.deepEqual(searchModels([], "x"), []);
});

test("catalogSource: the host's version and the list's age, or why the list is short", () => {
  assert.equal(catalogSource("claude", claudeCat, NOW), "From Claude Code 2.1.293 · 2m ago");
  assert.equal(catalogSource("codex", codexCat, NOW), "From Codex 0.158.0 · 1h ago");
  assert.equal(catalogSource("codex", codexDown, NOW), "Codex listed no models");
  assert.equal(catalogSource("claude", { ...claudeDown, reason: undefined }, NOW), "Claude Code did not answer");
  assert.equal(catalogSource("claude", null, NOW), "Claude Code has not been asked yet");
  assert.equal(catalogSource("claude", { ...claudeCat, version: null, fetchedAt: "" }, NOW), "From Claude Code");
});

// ── access levels ──

test("access levels: three, in order, with their words, descriptions and each host's mapping", () => {
  assert.deepEqual(ACCESS_LEVELS.map((l) => [l.id, l.label]), [["read", "Read only"], ["edit", "Edit files"], ["run", "Edit and run commands"]]);
  assert.equal(DEFAULT_ACCESS, "edit");
  assert.ok(ACCESS_LEVELS.every((l) => l.description.endsWith(".") && !l.description.includes("!")));
  assert.deepEqual(ACCESS_LEVELS.map((l) => accessHostLine(l)), [
    "Claude: plan mode · Codex: read-only sandbox",
    "Claude: acceptEdits · Codex: workspace-write",
    "Claude: acceptEdits + Bash · Codex: same as Edit files",
  ]);
  assert.equal(accessHostLine(ACCESS_LEVELS[2], "codex"), "Codex: same as Edit files");
  assert.equal(accessHostLine(ACCESS_LEVELS[0], "claude"), "Claude: plan mode");
  assert.equal(CODEX_ACCESS_NOTE, "Codex runs commands inside its sandbox at every level that edits, with no network.");
  assert.deepEqual(["read", "edit", "run"].map((a) => accessLabel(a as "read")), ["Read only", "Edit files", "Edit and run commands"]);
  assert.deepEqual(["read", "run", "write", null, undefined, 1].map(isAccess), [true, true, false, false, false, false]);
});

// ── the `/` menu ──

const cmd = (name: string, description = "", prefix = "/"): CatalogCommand => ({ name, insert: `${prefix}${name} `, description, hint: null });

test("commandQuery and commandTyping: a leading / (or $ on Codex) and no whitespace yet", () => {
  assert.equal(commandQuery("/", "claude"), "");
  assert.equal(commandQuery("/rev", "claude"), "rev");
  assert.equal(commandQuery("/agenticos:rec", "claude"), "agenticos:rec");
  assert.equal(commandQuery("/review now", "claude"), null);
  assert.equal(commandQuery("/review\\n", "claude"), "review\\n");
  assert.equal(commandQuery("/review\n", "claude"), null);
  assert.equal(commandQuery("$rev", "claude"), null, "$ is Codex's");
  assert.equal(commandQuery("$rev", "codex"), "rev");
  assert.equal(commandQuery("/rev", "codex"), "rev");
  assert.equal(commandQuery("fix /this", "claude"), null);
  assert.equal(commandQuery("", "codex"), null);
  assert.equal(commandTyping("/", "claude"), true);
  assert.equal(commandTyping("$x y", "codex"), false);
  assert.equal(commandTyping(" /x", "claude"), false);
});

test("filterCommands: name prefix first, then a part's prefix, then the name or the description; capped, with the total", () => {
  const cmds = [
    cmd("security-review", "Security review of the pending changes"),
    cmd("agenticos:recall", "Search your memory"),
    cmd("review", "Review a pull request"),
    cmd("init", "Write a CLAUDE.md"),
    cmd("code-review", "Review the current diff"),
    cmd("prereview", "Runs before the review"),
    cmd("simplify", "Clean up the code for reuse"),
  ];
  const r = filterCommands(cmds, "re");
  assert.deepEqual(r.items.map((c) => c.name), ["review", "security-review", "agenticos:recall", "code-review", "prereview", "simplify"]);
  assert.equal(r.total, 6);
  assert.deepEqual(filterCommands(cmds, "REVIEW").items.map((c) => c.name), ["review", "security-review", "code-review", "prereview"]);
  assert.deepEqual(filterCommands(cmds, "memory").items.map((c) => c.name), ["agenticos:recall"]);
  assert.deepEqual(filterCommands(cmds, "").items.map((c) => c.name), cmds.map((c) => c.name), "an empty query lists them all, in order");
  const capped = filterCommands(cmds, "", 2);
  assert.deepEqual([capped.items.length, capped.total], [2, 7]);
  assert.deepEqual(filterCommands(cmds, "zzz"), { items: [], total: 0 });
  assert.deepEqual(filterCommands([], "x"), { items: [], total: 0 });
  const many = Array.from({ length: 80 }, (_, i) => cmd(`skill-${i}`, "", "$"));
  const def = filterCommands(many, "skill");
  assert.deepEqual([def.items.length, def.total, def.items[0].insert], [50, 80, "$skill-0 "]);
});

// ── the reader's rows ──

const tool = (name: string, toolKind: string, summary = "", filePath: string | null = null): ToolCall => ({ name, toolKind, summary, filePath });
const ROOT = "/vault/workspaces/harbor-map";

test("toolCallLine: Read, Update and Write with the file (relative to the workspace), Bash with the command", () => {
  assert.deepEqual(toolCallLine(tool("Read", "read", "{\"file_path\":\"x\"}", `${ROOT}/src/a.ts`), ROOT), { verb: "Read", target: "src/a.ts" });
  assert.deepEqual(toolCallLine(tool("Edit", "edit", "", `${ROOT}/src/a.ts`), ROOT), { verb: "Update", target: "src/a.ts" });
  assert.deepEqual(toolCallLine(tool("MultiEdit", "edit", "", "/elsewhere/b.ts"), ROOT), { verb: "Update", target: "/elsewhere/b.ts" });
  assert.deepEqual(toolCallLine(tool("Write", "edit", "", `${ROOT}/new.md`), ROOT), { verb: "Write", target: "new.md" });
  assert.deepEqual(toolCallLine(tool("Bash", "bash", JSON.stringify({ command: "npm test -- agentSessions", description: "Run the tests" }))), { verb: "Bash", target: "npm test -- agentSessions" });
  // The runtime clipped a long input: the command is still read out of it.
  const clipped = `${JSON.stringify({ command: `echo "${"x".repeat(500)}"` }).slice(0, 399)}…`;
  const b = toolCallLine(tool("Bash", "bash", clipped));
  assert.equal(b.verb, "Bash");
  assert.ok(b.target.startsWith("echo \"xxx") && b.target.endsWith("…") && b.target.length <= 120);
});

test("toolCallLine: Codex's shell is Bash with the command out of its shell wrapper", () => {
  assert.deepEqual(toolCallLine(tool("shell", "bash", "/bin/zsh -lc 'npm test'")), { verb: "Bash", target: "npm test" });
  assert.deepEqual(toolCallLine(tool("shell", "bash", "bash -lc \"git status --short\"")), { verb: "Bash", target: "git status --short" });
  assert.deepEqual(toolCallLine(tool("shell", "bash", "ls -la")), { verb: "Bash", target: "ls -la" });
});

test("toolCallLine: Grep and Glob are Search; MCP tools are server/tool; other tools by name with a plain field", () => {
  assert.deepEqual(toolCallLine(tool("Grep", "other", JSON.stringify({ pattern: "timelineRows", path: `${ROOT}/src` })), ROOT), { verb: "Search", target: "timelineRows in src" });
  assert.deepEqual(toolCallLine(tool("Glob", "other", JSON.stringify({ pattern: "**/*.test.ts" }))), { verb: "Search", target: "**/*.test.ts" });
  assert.deepEqual(toolCallLine(tool("mcp__plugin_agenticos_agenticos__recall", "mcp", JSON.stringify({ query: "sessions" }))), { verb: "plugin_agenticos_agenticos/recall", target: "{\"query\":\"sessions\"}" });
  assert.deepEqual(toolCallLine(tool("mcp__docs__search__v2", "mcp", "{}")), { verb: "docs/search__v2", target: "" });
  assert.deepEqual(toolCallLine(tool("mcp__context7__query-docs", "mcp", "")), { verb: "context7/query-docs", target: "" });
  assert.deepEqual(toolCallLine(tool("Task", "other", JSON.stringify({ description: "Find the composer", prompt: "…" }))), { verb: "Task", target: "Find the composer" });
  assert.deepEqual(toolCallLine(tool("WebFetch", "other", JSON.stringify({ url: "https://example.com", prompt: "x" }))), { verb: "Fetch", target: "https://example.com" });
  assert.deepEqual(toolCallLine(tool("Frobnicate", "other", JSON.stringify({ path: "a/b" }))), { verb: "Frobnicate", target: "a/b" });
  assert.deepEqual(toolCallLine(tool("", "other", "")), { verb: "Tool", target: "" });
  assert.equal(relPath(`${ROOT}/a`, `${ROOT}/`), "a");
  assert.equal(relPath(`${ROOT}x/a`, ROOT), `${ROOT}x/a`, "a sibling folder is not under the root");
  assert.equal(relPath("a/b", null), "a/b");
});

test("toolResultText: nothing while running; a failure's words; an edit's +/− from git; else the start of the output", () => {
  const row = (t: ToolCall, result: { ok: boolean; summary: string } | null): Extract<ThreadRow, { kind: "tool" }> =>
    ({ kind: "tool", turn: 1, key: "1:t", tool: t, result, ...toolCallLine(t) });
  assert.equal(toolResultText(row(tool("Bash", "bash"), null)), null);
  assert.equal(toolResultText(row(tool("Bash", "bash"), { ok: false, summary: "Exit code 1   npm ERR" })), "Exit code 1 npm ERR");
  assert.equal(toolResultText(row(tool("Bash", "bash"), { ok: false, summary: "" })), "Failed");
  assert.equal(toolResultText(row(tool("Bash", "bash"), { ok: true, summary: "44 passed · 0 failed" })), "44 passed · 0 failed");
  assert.equal(toolResultText(row(tool("Bash", "bash"), { ok: true, summary: "" })), "Done");
  assert.equal(toolResultText(row(tool("Read", "read", "", "a.ts"), { ok: true, summary: "1→// a.ts" })), "Read the file");
  const edit = row(tool("Edit", "edit", "", "a.ts"), { ok: true, summary: "The file a.ts has been updated" });
  assert.equal(toolResultText(edit, { added: 4, removed: 2 }), "+4 \u22122 · open to see the file's diff");
  assert.equal(toolResultText(edit, { added: null, removed: null }), "Done");
  assert.equal(toolResultText(edit), "Done");
  assert.equal(toolResultText(row(tool("shell", "bash"), { ok: true, summary: "x".repeat(300) }))?.length, 120);
});

test("threadRows: tool rows carry their verb and target; a turn's footer its length; timelineRows keeps the first shapes", () => {
  const events = [
    ev("prompt", 1, { text: "fix it", t: "2026-10-07T10:00:00.000Z" }),
    ev("tool", 1, { id: "t1", name: "Read", toolKind: "read", summary: "", filePath: `${ROOT}/src/a.ts`, t: "2026-10-07T10:00:05.000Z" }),
    ev("plan", 1, { items: [{ text: "Read", status: "done" }] }),
    ev("done", 1, { ok: true, usd: 0.1, estimated: false, t: "2026-10-07T10:02:14.000Z" }),
  ];
  const rows = threadRows(events, { root: ROOT });
  assert.deepEqual(rows.map((r) => r.kind), ["prompt", "tool", "plan", "done"]);
  const t = rows[1];
  assert.ok(t.kind === "tool");
  assert.deepEqual([t.verb, t.target], ["Read", "src/a.ts"]);
  const done = rows[3];
  assert.ok(done.kind === "done");
  assert.equal(done.ms, 134000);
  assert.equal(durationText(done.ms ?? 0), "2m 14s");
  assert.deepEqual(timelineRows(events).map((r) => r.kind), ["prompt", "tool", "done"]);
});

test("threadRows: only the latest plan of a turn, where its first plan was; each turn its own", () => {
  const rows = threadRows([
    ev("prompt", 1, { text: "go" }),
    ev("plan", 1, { items: [{ text: "Read the composer", status: "active" }, { text: "Add the menu", status: "pending" }] }),
    ev("text", 1, { text: "Reading." }),
    ev("plan", 1, { items: [{ text: "Read the composer", status: "done" }, { text: "Add the menu", status: "active" }] }),
    ev("plan", 1, { items: [{ text: "Read the composer", status: "done" }, { text: "Add the menu", status: "done" }, { text: "", status: "done" }, { text: "Odd", status: "later" }] }),
    ev("done", 1, { ok: true }),
    ev("prompt", 2, { text: "again" }),
    ev("plan", 2, { items: [{ text: "Test", status: "pending" }] }),
    ev("plan", 2, { items: "not a list" }),
  ]);
  assert.deepEqual(rows.map((r) => r.kind), ["prompt", "plan", "text", "done", "prompt", "plan"]);
  const [p1, p2] = rows.filter((r): r is Extract<ThreadRow, { kind: "plan" }> => r.kind === "plan");
  assert.deepEqual(p1.items, [{ text: "Read the composer", status: "done" }, { text: "Add the menu", status: "done" }, { text: "Odd", status: "pending" }]);
  assert.equal(p1.turn, 1);
  assert.deepEqual(p2.items, [], "the turn's latest plan, even an empty one");
});

test("threadRows: a marker before a turn whose model, effort or access changed, named from the catalog; none otherwise", () => {
  const p = (turn: number, fields: Record<string, unknown>) => ev("prompt", turn, { text: `turn ${turn}`, ...fields });
  const rows = threadRows([
    p(1, { model: "gpt-6-sol", effort: "high", access: "edit" }),
    p(2, { model: "gpt-6-sol", effort: "high", access: "edit" }),
    p(3, { model: "gpt-6-astra", effort: "max", access: "edit" }),
    p(4, { model: "gpt-6-astra", effort: "max", access: "read" }),
    p(5, { model: null, effort: "max", access: "read" }),
  ], { host: "codex", catalog: codexCat });
  const marks = rows.filter((r): r is Extract<ThreadRow, { kind: "change" }> => r.kind === "change");
  assert.deepEqual(rows.map((r) => r.kind), ["prompt", "prompt", "change", "prompt", "change", "prompt", "change", "prompt"]);
  assert.deepEqual(marks.map((m) => m.text), [
    "Next turn on GPT-6-Astra · Max",
    "Next turn on GPT-6-Astra · Max · Read only",
    "Next turn on Codex default · Max",
  ]);
  assert.deepEqual(marks.map((m) => [m.turn, m.model, m.effort, m.access]), [[3, "gpt-6-astra", "max", "edit"], [4, "gpt-6-astra", "max", "read"], [5, null, "max", "read"]]);
});

test("threadRows: prompts of an older thread record no choices, and no marker comes of it", () => {
  const rows = threadRows([
    ev("prompt", 1, { text: "a" }),
    ev("prompt", 2, { text: "b", model: "opus", effort: "high", access: "edit" }),
    ev("prompt", 3, { text: "c" }),
    ev("prompt", 4, { text: "d", model: "opus", effort: "low", access: "run" }),
  ]);
  const marks = rows.filter((r): r is Extract<ThreadRow, { kind: "change" }> => r.kind === "change");
  assert.deepEqual(marks.map((m) => [m.turn, m.text]), [[4, "Next turn on opus · Low · Edit and run commands"]]);
  // Without a catalog the model is its id; Claude's default alias is Default.
  const d = threadRows([ev("prompt", 1, { model: "opus" }), ev("prompt", 2, { model: "default" })], { host: "claude" });
  assert.deepEqual(d.flatMap((r) => (r.kind === "change" ? [r.text] : [])), ["Next turn on Default"]);
});

test("turnElapsed, durationText and workingText: the working line's clock", () => {
  const at = (s: number) => new Date(Date.parse("2026-10-07T10:00:00.000Z") + s * 1000).toISOString();
  const running = [ev("prompt", 1, { t: at(0) }), ev("done", 1, { t: at(30) }), ev("prompt", 2, { t: at(60) }), ev("text", 2, { t: at(70) })];
  assert.equal(turnElapsed(running, new Date(at(108))), 48000);
  assert.equal(turnElapsed(running.slice(0, 2), new Date(at(500))), 30000, "a finished turn stops at its done");
  assert.equal(turnElapsed([], NOW), null);
  assert.equal(turnElapsed([ev("prompt", 1, { t: "not a time" })], NOW), null);
  assert.equal(turnElapsed([ev("prompt", 1, { t: at(10) })], new Date(at(0))), 0, "a clock behind the prompt is no time");
  assert.deepEqual([0, 999, 48000, 134000, 3600000, 3900000].map(durationText), ["0s", "0s", "48s", "2m 14s", "1h 0m", "1h 5m"]);
  assert.equal(workingText(48000), "Working… (48s · esc to stop)");
  assert.equal(workingText(null), "Working… (esc to stop)");
  assert.equal(workingText(48000, true), "Stopping…");
});

// ── the repository and the list ──

test("diffTotals, countsText and fileCounts: +/− across files, a binary file counted as unknown", () => {
  const st: HostGitStatus = { repo: true, branch: "main", detached: false, merging: false, files: [
    { path: "src/a.ts", status: ".M", added: 40, removed: 10 },
    { path: "src/b.ts", status: "??", added: 8, removed: 2 },
    { path: "logo.png", status: "A.", added: null, removed: null },
  ] };
  assert.deepEqual(diffTotals(st), { added: 48, removed: 12, files: 3, unknown: 1 });
  assert.equal(countsText(diffTotals(st)), "+48 \u221212");
  assert.equal(countsText({ added: null, removed: 3 }), "");
  assert.equal(countsText({ added: 0, removed: 0 }), "+0 \u22120");
  assert.deepEqual(diffTotals({ ...st, repo: false }), { added: 0, removed: 0, files: 0, unknown: 0 });
  assert.deepEqual(diffTotals(null), { added: 0, removed: 0, files: 0, unknown: 0 });
  assert.deepEqual(fileCounts(st, `${ROOT}/src/a.ts`, ROOT), { added: 40, removed: 10 });
  assert.deepEqual(fileCounts(st, "logo.png"), { added: null, removed: null });
  assert.equal(fileCounts(st, "nope.ts"), null);
  assert.equal(fileCounts(null, "src/a.ts"), null);
});

test("threadAge: the list's short age", () => {
  const at = (s: number) => new Date(NOW.getTime() - s * 1000).toISOString();
  assert.deepEqual([at(10), at(12 * 60), at(3 * 3600), at(2 * 86400)].map((t) => threadAge(t, NOW)), ["now", "12m", "3h", "2d"]);
  assert.equal(threadAge(at(30 * 86400), NOW), at(30 * 86400).slice(0, 10));
});

test("turnChoices and doneLine: a finished turn names its model, effort, length and cost", () => {
  const events = [
    ev("prompt", 1, { text: "a", model: "opus", effort: "high", access: "edit" }),
    ev("prompt", 1, { text: "again", model: "haiku" }),
    ev("prompt", 2, { text: "old" }),
    ev("prompt", 3, { text: "c", model: null, effort: null }),
  ];
  assert.deepEqual([...turnChoices(events)], [[1, { model: "opus", effort: "high" }], [3, { model: null, effort: null }]]);
  const done = { kind: "done" as const, turn: 1, ok: true, footer: "$0.18 estimated · 1,200 in · 80 out", ms: 134000 };
  assert.equal(doneLine(done, "Opus 5.5 · High"), "Done · Opus 5.5 · High · 2m 14s · $0.18 estimated · 1,200 in · 80 out");
  assert.equal(doneLine({ ...done, ms: null }), "Done · $0.18 estimated · 1,200 in · 80 out");
  assert.equal(doneLine({ ...done, ok: false, footer: "did not finish · no cost recorded", ms: 4000 }, null), "Did not finish · 4s · no cost recorded");
});

test("lastTurnUsd: the last done's spend, else its usage's; null before a turn ends or without a cost", () => {
  assert.equal(lastTurnUsd([ev("prompt", 1)]), null);
  assert.deepEqual(lastTurnUsd([ev("done", 1, { ok: true, usd: 0.1 }), ev("prompt", 2), ev("usage", 2, { usd: 0.42 }), ev("done", 2, { ok: true, estimated: true })]), { usd: 0.42, estimated: true });
  assert.deepEqual(lastTurnUsd([ev("done", 1, { ok: true, usd: 0.1 }), ev("prompt", 2)]), { usd: 0.1, estimated: false });
  assert.equal(lastTurnUsd([ev("done", 1, { ok: false })]), null);
});

test("sessionSpendToday and spendLine: today's session:* rows against the cap", () => {
  const now = new Date(2026, 9, 7, 15, 0, 0);
  const at = (h: number, d = 7) => new Date(2026, 9, d, h, 0, 0).toISOString();
  const ledger = [
    JSON.stringify({ ts: at(9), feature: "session:claude", usd: 1.2 }),
    JSON.stringify({ ts: at(10), feature: "session:codex", usd: 0.64 }),
    JSON.stringify({ ts: at(11), feature: "reason:chat", usd: 3 }),
    JSON.stringify({ ts: at(9, 6), feature: "session:claude", usd: 5 }),
    "{\"ts\":\"torn session:",
    JSON.stringify({ ts: "bad", feature: "session:claude", usd: 1 }),
    "",
  ].join("\n");
  assert.equal(sessionSpendToday(ledger, now), 1.84);
  assert.equal(sessionSpendToday("", now), 0);
  assert.deepEqual(spendLine(1.84, 10), { text: "$1.84 of $10", ratio: 0.184 });
  assert.deepEqual(spendLine(12, 10), { text: "$12.00 of $10", ratio: 1 });
  assert.deepEqual(spendLine(0, 2.5), { text: "$0.00 of $2.50", ratio: 0 });
  assert.equal(spendLine(0, 0).ratio, 1);
});
