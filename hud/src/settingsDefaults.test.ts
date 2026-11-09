import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS, DEAD_SETTINGS_KEYS,
  sanitizeSessionChoice, sanitizeVaultChoice, rememberSessionChoice, rememberVaultChoice,
  sanitizeTerminalChoice, rememberTerminalChoice, TERM_RECENT_MAX,
  sanitizeFilesChoice, rememberFilesChoice, FILES_FAVORITES_MAX, FILES_RECENTS_MAX,
  sanitizeComputerPane, computerPaneStart, rememberComputerPane, COMPUTER_PANE_NARROW,
} from "./settingsDefaults";

test("the contract §5 settings exist with their defaults", () => {
  assert.equal(DEFAULT_SETTINGS.vaultRoot, "");
  assert.equal(DEFAULT_SETTINGS.claudeConfigDir, "");
  assert.equal(DEFAULT_SETTINGS.nodePath, "");
});

test("the seven pre-existing settings are unchanged (the Pulse terminal's two are gone)", () => {
  assert.deepEqual(Object.keys(DEFAULT_SETTINGS).slice(0, 7), [
    "statusBarEnabled", "autoOpenSidebarOnStart", "liveTailPollMs",
    "terminalShell", "terminalCwd", "terminalFontSize", "terminalScrollback",
  ]);
  assert.equal(DEFAULT_SETTINGS.liveTailPollMs, 300);
  assert.ok(!("terminalEmbedded" in DEFAULT_SETTINGS) && !("terminalEmbedHeight" in DEFAULT_SETTINGS));
});

test("cost and telemetry are the system's switches, not plugin settings (spec 2026-09-24-settings-tab D10)", () => {
  assert.equal("costEnabled" in DEFAULT_SETTINGS, false);
  assert.equal("telemetryEnabled" in DEFAULT_SETTINGS, false);
  assert.ok(DEAD_SETTINGS_KEYS.includes("costEnabled") && DEAD_SETTINGS_KEYS.includes("telemetryEnabled"), "a stored HUD-only value is pruned");
  for (const k of DEAD_SETTINGS_KEYS) assert.equal(k in DEFAULT_SETTINGS, false, k);
});

// ── remembered session choices (spec 2026-10-07-sessions-ux U12) ──

const EMPTY = { claude: null, codex: null };

test("the remembered choices default to no host, edit access and the hosts' defaults", () => {
  assert.deepEqual(DEFAULT_SETTINGS.sessionChoice, { host: null, access: "edit", models: EMPTY, efforts: EMPTY });
  assert.deepEqual(DEFAULT_SETTINGS.vaultChoice, { host: null, models: EMPTY, efforts: EMPTY });
  assert.equal("access" in DEFAULT_SETTINGS.vaultChoice, false, "Vault chat is always read only");
});

test("a data.json without the keys reads as the defaults", () => {
  for (const raw of [undefined, null, {}, [], "claude", 3, true]) {
    assert.deepEqual(sanitizeSessionChoice(raw), DEFAULT_SETTINGS.sessionChoice, String(raw));
    assert.deepEqual(sanitizeVaultChoice(raw), DEFAULT_SETTINGS.vaultChoice, String(raw));
  }
});

test("a well-formed choice reads back unchanged", () => {
  const session = {
    host: "codex", access: "run",
    models: { claude: "claude-opus-4-5[1m]", codex: "gpt-5.1-codex" },
    efforts: { claude: "max", codex: "ultra" },
  };
  assert.deepEqual(sanitizeSessionChoice(session), session);
  const vault = { host: "claude", models: { claude: "default", codex: "gpt-5.1-codex" }, efforts: { claude: "xhigh", codex: "minimal" } };
  assert.deepEqual(sanitizeVaultChoice(vault), vault);
});

test("bad parts fall back to their defaults and good parts are kept", () => {
  const got = sanitizeSessionChoice({
    host: "other", access: "admin",
    models: { claude: "sonnet", codex: 42 },
    efforts: { claude: "ultra", codex: "high" },
  });
  assert.deepEqual(got, { host: null, access: "edit", models: { claude: "sonnet", codex: null }, efforts: { claude: null, codex: "high" } });
  assert.deepEqual(sanitizeSessionChoice({ host: "claude", models: "opus", efforts: ["low"] }),
    { host: "claude", access: "edit", models: EMPTY, efforts: EMPTY });
});

test("a model id must be one word the app admits", () => {
  const model = (m: unknown) => sanitizeSessionChoice({ models: { claude: m } }).models.claude;
  assert.equal(model("  opus  "), "opus", "trimmed");
  for (const bad of ["", "   ", "--dangerously-skip-permissions", "two words", "a;b", "x".repeat(81), null, {}]) {
    assert.equal(model(bad), null, String(bad));
  }
});

test("Vault chat takes only the efforts its one-shot paths admit", () => {
  const got = sanitizeVaultChoice({ host: "codex", efforts: { claude: "max", codex: "max" } });
  assert.deepEqual(got.efforts, { claude: "max", codex: null }, "ask.js --effort= stops at xhigh");
  assert.equal("access" in sanitizeVaultChoice({ access: "run" }), false);
});

test("sanitizing returns a fresh copy, never the defaults or the input", () => {
  const raw = { host: "claude", access: "read", models: { claude: "opus", codex: null }, efforts: { claude: "low", codex: null }, extra: 1 };
  const got = sanitizeSessionChoice(raw);
  assert.notEqual(got.models, raw.models);
  assert.equal("extra" in got, false, "unknown keys are dropped");
  const fromDefault = sanitizeSessionChoice(undefined);
  fromDefault.models.claude = "haiku";
  assert.equal(DEFAULT_SETTINGS.sessionChoice.models.claude, null);
});

test("remembering a pick sets the host and replaces only what the pick names", () => {
  let c = rememberSessionChoice(undefined, { host: "claude", model: "opus", effort: "high", access: "read" });
  assert.deepEqual(c, { host: "claude", access: "read", models: { claude: "opus", codex: null }, efforts: { claude: "high", codex: null } });
  c = rememberSessionChoice(c, { host: "codex", model: "gpt-5.1-codex" });
  assert.deepEqual(c, { host: "codex", access: "read", models: { claude: "opus", codex: "gpt-5.1-codex" }, efforts: { claude: "high", codex: null } },
    "the other host's model and effort, and the access, are kept");
  c = rememberSessionChoice(c, { host: "claude", model: null });
  assert.equal(c.models.claude, null, "null goes back to the host's default");
  assert.equal(c.efforts.claude, "high");
  assert.equal(rememberSessionChoice(c, { host: "codex", effort: "turbo" }).efforts.codex, null, "a level the host does not take is dropped");
});

test("remembering a Vault chat pick works the same way and never stores access", () => {
  const v = rememberVaultChoice({ host: "other" }, { host: "codex", model: "gpt-5.1-codex", effort: "xhigh" });
  assert.deepEqual(v, { host: "codex", models: { claude: null, codex: "gpt-5.1-codex" }, efforts: { claude: null, codex: "xhigh" } });
  assert.deepEqual(rememberVaultChoice(v, { host: "claude" }).models, v.models);
});

// ── the Term tab's choice (spec 2026-10-08-term-agent-deck) ──

test("the Term choice defaults to no remembered host, Host default access, the vault, no recents", () => {
  assert.deepEqual(DEFAULT_SETTINGS.terminalChoice, { host: null, access: "host", agentPlace: "vault", recent: [] });
  for (const raw of [undefined, null, 7, "x", [], {}]) assert.deepEqual(sanitizeTerminalChoice(raw), DEFAULT_SETTINGS.terminalChoice, String(raw));
});

test("a Term choice keeps its good parts and drops the rest", () => {
  assert.deepEqual(sanitizeTerminalChoice({ host: "shell", access: "run", agentPlace: "last", recent: ["bz-wedding", "kite"] }),
    { host: "shell", access: "run", agentPlace: "last", recent: ["bz-wedding", "kite"] });
  assert.deepEqual(sanitizeTerminalChoice({ host: "gpt", access: "all", agentPlace: "home", recent: ["ok", ".git", "_worktrees", "a/b", 3, "ok"] }),
    { host: null, access: "host", agentPlace: "vault", recent: ["ok"] });
});

test("remembering a launch: the host becomes ⌘T's, the workspace moves to the front, at most five recents", () => {
  let c = rememberTerminalChoice(undefined, { host: "codex", workspace: "a" });
  assert.deepEqual([c.host, c.recent], ["codex", ["a"]]);
  for (const w of ["b", "c", "d", "e", "f", "a"]) c = rememberTerminalChoice(c, { workspace: w });
  assert.deepEqual(c.recent, ["a", "f", "e", "d", "c"]);
  assert.equal(c.recent.length, TERM_RECENT_MAX);
  assert.equal(rememberTerminalChoice(c, { access: "read" }).access, "read");
  assert.equal(rememberTerminalChoice(c, {}).host, "codex");
});

// ── Files (spec 2026-10-17-files-finder D21) ──

test("the Files choice defaults to Icons by name, no preview pane, the default favorites and no recents", () => {
  assert.deepEqual(DEFAULT_SETTINGS.files, { view: "icons", sort: { key: "name", desc: false }, preview: false, favorites: null, recents: [], updateLinks: true });
  for (const raw of [undefined, null, {}, [], "list", 3]) assert.deepEqual(sanitizeFilesChoice(raw), DEFAULT_SETTINGS.files, String(raw));
});

test("a Files choice keeps its good parts: paths inside the vault, deduplicated and capped; the vault itself as a favorite", () => {
  const raw = {
    view: "columns", sort: { key: "modified", desc: true }, preview: true,
    favorites: ["", "brain", "brain", "/etc", "../out", "a//b", "a/./b", 7, "workspaces/harbor-map"],
    recents: ["TODO.md", "", "TODO.md", "brain/../x.md", ...Array.from({ length: 60 }, (_, i) => `n/${i}.md`)],
  };
  const c = sanitizeFilesChoice(raw);
  assert.equal(c.view, "columns");
  assert.deepEqual(c.sort, { key: "modified", desc: true });
  assert.equal(c.preview, true);
  assert.deepEqual(c.favorites, ["", "brain", "workspaces/harbor-map"]);
  assert.equal(c.recents[0], "TODO.md");
  assert.equal(c.recents.length, FILES_RECENTS_MAX);
  assert.ok(!c.recents.includes("") && !c.recents.includes("brain/../x.md"));
  assert.equal(sanitizeFilesChoice({ favorites: Array.from({ length: 40 }, (_, i) => `f${i}`) }).favorites!.length, FILES_FAVORITES_MAX);
  assert.deepEqual(sanitizeFilesChoice({ view: "gallery", sort: { key: "colour", desc: "yes" }, preview: 1 }), DEFAULT_SETTINGS.files);
});

test("remembering a Files change replaces what it names and puts an opened file first", () => {
  let c = rememberFilesChoice(undefined, { view: "list" });
  assert.equal(c.view, "list");
  c = rememberFilesChoice(c, { opened: "a.md" });
  c = rememberFilesChoice(c, { opened: "b.md" });
  c = rememberFilesChoice(c, { opened: "a.md", sort: { key: "size", desc: true } });
  assert.deepEqual(c.recents, ["a.md", "b.md"]);
  assert.deepEqual(c.sort, { key: "size", desc: true });
  assert.deepEqual(rememberFilesChoice(c, { favorites: ["brain"] }).favorites, ["brain"]);
  assert.equal(rememberFilesChoice({ ...c, favorites: ["brain"] }, { favorites: null }).favorites, null);
  assert.notEqual(rememberFilesChoice(DEFAULT_SETTINGS.files, {}), DEFAULT_SETTINGS.files, "a fresh copy");
});

test("a rename or move in Files takes the favorites and recents along, a folder everything under it (files-finder D20)", () => {
  const c = { ...DEFAULT_SETTINGS.files, favorites: ["", "brain", "work/old", "work/older"], recents: ["work/old/a.md", "b.md", "work/oldx.md"] };
  const moved = rememberFilesChoice(c, { moved: [{ from: "work/old", to: "work/new" }, { from: "b.md", to: "c/b.md" }] });
  assert.deepEqual(moved.favorites, ["", "brain", "work/new", "work/older"]);
  assert.deepEqual(moved.recents, ["work/new/a.md", "c/b.md", "work/oldx.md"]);
  assert.equal(rememberFilesChoice({ ...c, favorites: null }, { moved: [{ from: "brain", to: "x" }] }).favorites, null, "the defaults stay the defaults");
  assert.deepEqual(rememberFilesChoice(c, { moved: [] }), sanitizeFilesChoice(c));
});

test("Update links (files-finder D17) stays on until it is turned off, and only false turns it off", () => {
  assert.equal(sanitizeFilesChoice({ updateLinks: false }).updateLinks, false);
  for (const v of [true, undefined, 0, "no", null]) assert.equal(sanitizeFilesChoice({ updateLinks: v }).updateLinks, true, String(v));
  const off = rememberFilesChoice(undefined, { updateLinks: false });
  assert.equal(off.updateLinks, false);
  assert.equal(rememberFilesChoice(off, { view: "list" }).updateLinks, false, "another change keeps it");
  assert.equal(rememberFilesChoice(off, { updateLinks: true }).updateLinks, true);
});

// ── the Computer pane (agent-computer D4): its width and whether it is collapsed, per page ──

const OPEN = { width: 440, collapsed: false };

test("the Computer pane is 440 px wide and open on both pages until it is changed; junk reads as that", () => {
  assert.deepEqual(DEFAULT_SETTINGS.computerPane, {}, "nothing stored: each page starts from the defaults");
  for (const raw of [undefined, null, 7, "x", [], {}, { code: "wide" }, { chat: [] }, { code: null }]) {
    assert.deepEqual(sanitizeComputerPane(raw), { code: OPEN, chat: OPEN }, JSON.stringify(raw) ?? String(raw));
  }
});

test("sanitizeComputerPane keeps a width inside 320–900 in whole pixels and a real boolean, and drops the rest", () => {
  const got = sanitizeComputerPane({ code: { width: 100, collapsed: true }, chat: { width: 5000, collapsed: "yes" }, other: { width: 500 } });
  assert.deepEqual(got, { code: { width: 320, collapsed: true }, chat: { width: 900, collapsed: false } });
  assert.equal("other" in got, false);
  for (const w of [NaN, Infinity, -Infinity, "600", null, {}, true]) {
    assert.equal(sanitizeComputerPane({ code: { width: w } }).code.width, 440, String(w));
  }
  assert.equal(sanitizeComputerPane({ chat: { width: 512.6 } }).chat.width, 513);
  const fresh = sanitizeComputerPane(undefined);
  fresh.code.width = 600;
  assert.equal(sanitizeComputerPane(undefined).code.width, 440, "a fresh copy each time");
});

test(`under ${COMPUTER_PANE_NARROW} px a page with nothing saved starts collapsed; a saved choice wins at any width`, () => {
  assert.equal(COMPUTER_PANE_NARROW, 760);
  assert.deepEqual(computerPaneStart({}, "code", 700), { width: 440, collapsed: true });
  assert.deepEqual(computerPaneStart(undefined, "chat", 759), { width: 440, collapsed: true });
  assert.deepEqual(computerPaneStart({}, "code", 760), OPEN);
  assert.deepEqual(computerPaneStart({ code: { width: 500, collapsed: false } }, "code", 700), { width: 500, collapsed: false }, "the user's toggle wins");
  assert.deepEqual(computerPaneStart({ code: { width: 500, collapsed: false } }, "chat", 700), { width: 440, collapsed: true });
  assert.deepEqual(computerPaneStart({ chat: "junk" }, "chat", 700), { width: 440, collapsed: true }, "junk is nothing saved");
});

test("remembering one page's pane keeps the other page as it was stored, nothing saved included", () => {
  const once = rememberComputerPane({}, "chat", { width: 610, collapsed: true });
  assert.deepEqual(once, { chat: { width: 610, collapsed: true } });
  assert.deepEqual(rememberComputerPane(once, "code", { width: 9999, collapsed: false }), { chat: { width: 610, collapsed: true }, code: { width: 900, collapsed: false } });
  assert.deepEqual(rememberComputerPane("junk", "code", { width: 300, collapsed: false }), { code: { width: 320, collapsed: false } });
  assert.deepEqual(rememberComputerPane({ code: 4, chat: { width: 700, collapsed: false } }, "chat", { width: 701, collapsed: true }), { chat: { width: 701, collapsed: true } });
});
