# `aos config` — design

Date: 2026-09-24 · Branch: `feat/aos-config` · Verified against `fa240ae` (v0.16.0), Claude Code 2.1.281, codex-cli 0.156.1

Phase 1 of the Settings tab: the one safe way to read and change a setting. The HUD tab (phase 2) and presets, undo
and search (phase 3) build on it; neither is in this PR.

## 1. Problem

Settings live in five places: the Obsidian plugin's `data.json` (15), `agenticos.json` (the machine file), the vault's
`brain/config.json` (75 leaf keys in 19 sections, `brain/scripts/config.default.json`), flag files (`persona/DISABLED`),
and per-item switches (routines, skills, agents). Only a few have a verb (`aos provider`, `aos cost`, `aos graph`,
`aos persona on|off`, `aos update-status --off`, `aos skills|agents exclude`); the rest are hand-edited JSON, where:

- **A write can do nothing.** `loadConfig()` merges defaults ← `brain/config.json` ← `agenticos.json`
  (`lib/config.js:22-28`), and `aos init` writes `provider`, `claude.*`, `ollama`, `telemetry`, `cost.enabled`,
  `persona.enabled` and `graph.enabled` into `agenticos.json` (`cli/aos.js:618-630`). The same key edited in
  `brain/config.json` is silently overridden.
- **Writes are not atomic.** `writeJson` in `cli/aos.js:73`, `cost-cmd.js:27` and `graph-cmd.js:32` rewrite in place; a
  hook that reads a half-written `agenticos.json` gets `null`, then defaults and a Claude-only host.
- **0 is not 0.** `Number(x) || default` turns a `perDayUsd: 0` back into the default for the codex and reasoner caps
  (`sdk/lib/provider.js:97,136,146`), the semantic graph (`graph-claude.js:75,119`, `graph-build.js:185`) and
  cross-review (`cross-review/runner.js:338,415`), while `claude.perDayUsd`, persona and routines honour it.
- **A key nobody reads.** `scan.autoSweepOrphans` is in the defaults, but only `brain/_index/scanner-config.json`
  gates the sweep (`sweep-orphans.js:106`).
- **No session can change a setting on request** without editing JSON: there is no generic verb (`cli/aos.js:45-59`).

## 2. Decisions

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| D1 | **One verb, `aos config`:** `list [--json]` · `get <key> [--json]` · `set <key> <value> [--dry-run] [--json]` · `unset <key> [--dry-run]`. Keys are dotted paths (`graph.semantic.enabled`). | A verb per area; `aos settings`. | One entry point for the CLI, both hosts' `/aos`, and the HUD (phase 2). `config` names what it edits. |
| D2 | **One schema, `lib/settings-schema.js`:** per key its section, label, one-line help, type (`bool`, `enum`, `number`, `string`, `model`, `list`, `object`), allowed values, min/max, whether it is nullable, when it applies, a risk class (`spend`, `autonomy`, `privacy`, or none), and `readonly` with a `how` line for the machine keys. Defaults are read from `config.default.json`, never copied. | Types inferred from the default value; JSON Schema. | Inference cannot tell a model name from a path or `null`-means-host-default from off. JSON Schema needs a dependency or a hand-written validator anyway. |
| D3 | **Drift test:** every leaf of `config.default.json` has a schema entry, every non-machine entry exists in the defaults, and every default passes its own entry's validation. | Trust review. | A new key without a schema line fails CI in the PR that adds it. |
| D4 | **Which file `set` writes: the one that currently holds the key.** `agenticos.json` if it has the key (it wins the merge), else `brain/config.json`. A key read only from the vault (`dailyNote.layout`, `lib/paths.js:80-86`) always goes to `brain/config.json`. `unset` removes the key from both files, so the default applies, and prunes emptied parents. | A fixed home file per key; always the vault file. | A fixed home would recreate the silent no-op whenever the other file holds the key; the vault-only rule does it for every key `aos init` wrote. |
| D5 | **One writer, `lib/config-write.js`:** strict read (a file that exists but does not parse, or is not an object, is refused, never replaced), `tmp.<pid>` + rename, 2-space pretty-print with key order kept (the launcher reads `agenticos.json` line by line with `sed`, `plugin/bin/aos:20-31`). `aos provider` and the cost/graph writers switch their local `writeJson` to tmp + rename. | Leave the old writers alone. | A setting changed from the HUD must never be the write that breaks every hook. |
| D6 | **Machine keys are read-only here:** `version`, `vault`, `node`, `claudeConfigDir`, `claude.bin`, `codex.bin`, `graph.bin`, `hosts.*`. `set` exits 1 with the command that changes them (`aos init --host …`, `aos uninstall --host …`, `aos upgrade`). | Allow them. | They are baked into the launcher, launchd plists and Codex wiring; flipping `hosts.codex.enabled` installs nothing. |
| D7 | **Side effects run inside `set`**, and the ones that need launchd or a sync are reported, not run: `provider` clears `provider-state.json` (as `aos provider` does); `cost.enabled` hands off to `cost-cmd` `enable({yes})` / `disable()` so the analyzer is installed; `persona.enabled` also creates or removes `persona/DISABLED`; `dailyNote.layout` rewrites `.obsidian/daily-notes.json` when `.obsidian/` exists. `claude.model` → `next: aos routines sync`; `skills.*` / `agents.*` → `next: aos skills|agents sync`. `--json` returns them as `followUps`. | `set` runs `routines sync` itself. | Reloading launchd plists from a config write is a surprise; phase 2 turns each follow-up into a button. |
| D8 | **`persona.enabled` is the whole Chief of Staff switch.** `aos persona on\|off` stays the duties-only switch (the `DISABLED` file alone). | Leave the two apart. | `persona.enabled: false` today still lets scheduled duties run (`run-duty.sh:102`), which no user means by "off". |
| D9 | **Refused in headless runs:** `set` and `unset` exit 1 when `AOS_HEADLESS=1`, the marker every duty, routine and model call carries (`lib/headless.js:203`, `run-duty.sh:261,267`). | Refuse only the risk-tagged keys. | No duty needs to change settings; an agent must not raise its own budget or switch telemetry off. It is a speed bump (a process can unset the variable); the fence is duty write-scope, unchanged here. |
| D10 | **`perDayUsd: 0` means no spend, everywhere:** a shared `dayCap(value, default)` in `lib/settings-schema.js` (pure; `lib/config.js` resolves a vault when it loads, and the cross-review runner loads config lazily) keeps 0 and falls back only for missing or non-numeric values, used by the eight sites above. `perCallUsd` must be > 0 (the schema refuses 0). | Refuse 0 in the schema only. | 0 already means "no calls" for `claude.perDayUsd`, persona and routines; one meaning for every cap is what a settings UI can show honestly. |
| D11 | **`scan.autoSweepOrphans` is wired:** a boolean in `scanner-config.json` still wins; otherwise the product config decides (`agenticos.json` over `brain/config.json`, as `loadConfig` merges). | Delete the key. | `aos upgrade` never removes keys from a vault's `brain/config.json`, so a deleted default would linger unread. |
| D12 | **`aos doctor` gets a `config` row:** both files parse; unknown keys (a typo such as `telemetry.enabeld`) and values that fail validation are a warn naming the key and file. | No row. | Hand edits stay possible; doctor catches the ones that silently do nothing. |

## 3. What already exists (at `fa240ae`)

- `lib/config.js` `loadConfig`/`deepMerge` (read-only); `lib/paths.js` `configFile()`, `dailyNoteLayoutFor` `:80`.
- Writers: `cli/aos.js` `writeJson` `:73`, `readJsonStrict` `:77`, `provider()` `:549`; `cli/cost-cmd.js` `enable` `:69`,
  `disable` `:115`; `cli/graph-cmd.js` `setEnabled`/`setSemantic` `:311-322`; `cli/update-check.js` `writeAtomic` `:97`;
  `cli/skills.js` `setExcluded` `:115` (the tmp + rename precedent, and `resolveModule` for checkout vs vendored runs).
- Dispatch: `cli/aos.js` `USAGE` `:45`, `--dry-run` allow-list `:1394`, `switch` `:1395`, doctor `:308`; launcher
  arm `plugin/bin/aos:95` (pinned by `cli/aos-wrapper.test.js`); `/aos` passes its arguments through
  (`plugin/commands/aos.md:7`).

## 4. Design

**`brain/scripts/lib/settings-schema.js`** exports `SECTIONS` (ordered: Provider & models, Spend limits, Memory &
scanning, Chief of Staff, Routines, Knowledge graph, Cross-review, Skills & agents, Telemetry & privacy, Updates, Hosts &
install), `SETTINGS` (one entry per key, D2), `entry(key)`, `parseValue(entry, text)` (CLI text → value: `true/false/on/off`,
numbers, `null` for nullable keys, JSON for `list`/`object`) and `validate(entry, value)` → error string or null.

**`brain/scripts/lib/config-write.js`** exports `readStrict(file)`, `writeAtomic(file, obj)`, `getPath/setPath/unsetPath`
(dotted, prune empty parents), `effective({ vaultCfg, userCfg })` → per key `{ value, source: default|vault|machine }`,
`targetFile(key, files)` (D4) and `unknownKeys(obj, file)` (D12).

**`cli/config-cmd.js`** (`main(argv, opts)`, every effect injectable like `cli/skills.js`): `list` prints one block per
section, `key  value  source` with `*` on values changed from the default, and the two file paths in the head. `--json`
prints `{ schema: 1, files: { machine, vault }, settings: [{ key, section, label, help, type, values, min, max,
nullable, risk, applies, readonly, how, default, value, source }] }`. `set` prints
`<key>: <old> → <new> (<file>)`, then one `next: …` line per follow-up. Exit codes: 0 ok, 1 refused (read-only, headless,
unparseable file), 2 usage (unknown key, invalid value).

**`cli/aos.js`**: `config` in `USAGE`, the switch, the `--dry-run` allow-list; the doctor row; `provider()` and the
local writers go atomic. **`plugin/bin/aos`**: `config` in the maintenance arm. **`plugin/commands/aos.md`**: `config`
in the description and hint, and a bullet: run `set`/`unset` only for a change the user asked for in this
conversation, relay the confirmation and every `next:` line, never work around a refusal.

## 5. Host parity

1. **Entry:** `aos config …` (host-neutral); `/aos config …` in Claude Code; `$agenticos:aos config …` (Codex plugin) or
   `$aos config …` (direct), generated from `plugin/commands/aos.md`. No new command, so the counts stay 19 + 9 → 26.
2. **Hooks:** none added or changed. Nothing to re-trust.
3. **Model calls:** none. The cap fix (D10) changes the codex, reasoner, graph and cross-review budgets identically on both hosts.
4. **Session data:** none; files resolve through `configFile()` and the vault the CLI already resolves.
5. **MCP:** none (no write tool, D9).
6. **Degradation:** a vault not yet upgraded has no `config` arm, so the launcher prints `unknown script config`; README
   and CHANGELOG say `aos upgrade`. Keys for a disabled host still list and set (a Codex-only user can pre-set `claude.model`).
7. **Docs:** README "Everyday commands" row, `vault-template/AGENTICOS.md` maintenance line, `docs/plugin-smoke.md`
   item per host, CHANGELOG `[Unreleased]`.

| Mode | How the user invokes it | What runs | What they see if it can't |
|---|---|---|---|
| Claude Code only | `aos config …` · `/aos config …` | `cli/config-cmd.js` through the launcher | the refusal line (read-only key, headless, unparseable file) and exit 1 |
| Codex only (plugin · direct) | `aos config …` · `$agenticos:aos config …` · `$aos config …` | the same | the same |
| Both | all of the above | the same | the same |

## 6. Testing

- `brain/scripts/test/settings-schema.test.js`: drift both ways (D3); every default validates; `parseValue` per type,
  including `null`, JSON lists and bad input; `perCallUsd` 0 refused, `perDayUsd` 0 accepted.
- `brain/scripts/test/config-write.test.js`: atomic write leaves no tmp file and keeps key order; refuses an unparseable
  or array file; D4 target in each case; `unset` prunes; `effective` sources; `unknownKeys` stops at `object` keys.
- `cli/config-cmd.test.js` (tmp vault + `AOS_CONFIG`): list/get/set/unset text and `--json`; `--dry-run` writes
  nothing; each D7 side effect with injected cost enable/disable; read-only and headless refusals; exit codes.
- `dayCap` with 0, null, a string and a number; a 0 cap at the provider (codex, reasoner), graph-build and cross-review;
  sweep-orphans with the vault key; `cli/aos-wrapper.test.js` arm; doctor row.
- Rehearsals `first-run.sh` and `codex-host.sh`; by hand: `/aos config get provider` in Claude Code and
  `$agenticos:aos config get provider` in Codex.

## 7. Out of scope

- The HUD (phase 2): the Settings tab, the rail footer, `runAosJson()`, the HUD-only Cost/Telemetry toggles becoming the
  real switches, one plugin-side schema for Obsidian's settings pane.
- Change log and undo, presets, search (phase 3); `persona/autoapply.json`, `persona/repos.json` and
  `scanner-config.json` beyond D11.
- Locking against two writers at once (each write is atomic; the last one wins); changing machine keys (D6).
