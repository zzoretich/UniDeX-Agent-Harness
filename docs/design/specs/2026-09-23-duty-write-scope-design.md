# Duty write scope — design

Date: 2026-09-23 · Branch: `feat/duty-write-scope` · Verified against `0e951f3` (v0.13.0) · The second part of the
Workbench 1.0 proposal's Proposal 1 ("put the guardrails out of the agent's reach"), after the recipe guard

## 1. Problem

The recipe guard closed the *automatic* paths: no recipe runs outside a read-only grammar, and no headless process
records an approval through `ledger.js`. The *file* path is still open. A duty is a headless agent steered by text it
did not write (commit subjects, correction quotes, journal lines), and today it can write almost anywhere:

- **Claude runner.** `run-duty.sh:75` grants bare `Write,Edit` ("unscoped — guarded files rely on the proposal protocol").
  Claude Code confines Write/Edit to the working directory, so the whole vault is writable: `brain/scripts/*.js` (run
  unsandboxed by the next session's hooks), `persona/routines/*.md` (a duty can widen its own `tools:` line),
  `persona/autoapply.json` and `ledger.jsonl` (the ledger's headless refusal only binds callers of `ledger.js`),
  `.obsidian/plugins/*/main.js`, `.git/hooks/*`, and every project under `workspaces/`.
- **Git write-out.** The same allowlist grants `Bash(git log:*)` and `Bash(git diff:*)`. `git log -1 --format=%B
  --output=<path>` writes the commit message, verbatim, to any path the user can write (checked live: git accepts the
  full `--output=` and rejects abbreviations). Edit rules do not bind subprocesses.
- **Script path flags.** The allowlisted persona scripts take `--root`, `--file` or a file argument
  (`ledger.js append … --file <any>`, `proposal-html.js <any.md>`, `tick.js --root <any>`), so they append or rewrite
  files outside the vault on request.
- **Codex runner.** `run-duty.sh:211` runs `codex exec -s workspace-write` with the vault as cwd: the same vault-wide
  write, with no per-tool allowlist (a documented Codex gap: the sandbox is the guard).

## 2. Decisions

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| D1 | **Claude: path-scoped edits, enforced.** The runner passes `--permission-mode dontAsk`, drops bare `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, every `Edit(…)`/`Write(…)` rule and unrestricted `Bash` from the duty's tools, appends one absolute `Edit(//<vault>/<path>)` rule per write-scope entry (D5) for the vault path as configured *and* its realpath, and denies the guarded and executable areas (D6's set, `ledger.jsonl`, `brain/scripts`, `brain/routines`, `workspaces`, `.git`, `.obsidian`, `.claude`, `.codex`, `.agents`). | `Write(<path>)` rules. Relative `Edit(<path>)` rules. Allow rules without dontAsk. | Claude Code ignores path rules on `Write`; `Edit(…)` governs Write, Edit and NotebookEdit. Live probes (Claude Code 2.1.281): relative and `/`-anchored rules did not match through a symlinked vault path, `//` absolute rules did; a user `defaultMode: auto` (duties inherit user settings) lets a classifier approve calls outside the allowlist, which `dontAsk` stops; deny beat an overlapping allow. |
| D2 | **Claude: no git write-out.** The runner drops `Bash(git log…)`, `Bash(git diff…)` and `Bash(git show…)` from a duty's tools (`git status` stays: it has no output option) and also passes `--disallowedTools "Bash(git *--output*)"`, which beats any allow rule. | Rely on the deny rule alone. A `git-read.js` wrapper. | No built-in duty prompt uses `git log`/`diff`/`show` (monitor uses `git status`). Mid-pattern `*` is documented, but a glob glued to `--output` is not, so the deny rule is the second layer, not the only one. |
| D3 | **Scripts pin their root when headless.** Under `AOS_HEADLESS=1`, `--root` must resolve (realpath) to the vault, `ledger.js --file` to its own ledger, and `proposal-html.js` file arguments must sit in `<vault>/persona/proposals`; otherwise exit 2. One helper, `lib/pin-root.js` (it resolves the vault lazily: `lib/paths.js` throws at require time without one), used by the four duty-allowlisted scripts that take a path: ledger, proposal-html, tick, reflect. `scan-arsenal.js --root` names the config dir and only prints, so it is left alone. | Drop the flags. | Tests and interactive use still need `--root`; only a duty is untrusted. `tick.js beat --root <x>` can start a runner under `<x>`, so the pin also closes a staged fake `brain/scripts` tree. |
| D4 | **Codex: a narrower workspace.** Codex duties start in `<vault>/persona` (`-C`), with `--add-dir` for each directory of the write scope outside it (`brain/_index`, `brain/reflections`, the daily-note folder, `writes:` dirs) and `-c sandbox_workspace_write.writable_roots=[]` so a user `config.toml` cannot add roots. `brain/scripts`, `brain/memory`, `brain/routines`, `workspaces/`, `.obsidian/` and the vault's `.git` become read-only to the duty. | Keep the vault as cwd. File-level `--add-dir` (e.g. only `STATE.md`). | Verified live with `codex exec` 0.156.1: only `persona/**` and the added folders were writable (the empty `writable_roots` does not cancel `--add-dir`); an un-added `brain/reflections` was refused. File roots are unverified. `persona/` stays writable as a whole, so D6 guards its trust files. |
| D5 | **One write scope, host-neutral.** Default for every duty: `persona/journal/**`, `persona/STATE.md`, `persona/proposals/**`, `persona/PLAYBOOK.md`, `brain/reflections/**`, `brain/_index/sitrep.md`, the folder of today's daily note. A routine may add entries with a new optional `writes:` key (vault-relative). An entry that is the vault root, contains or sits inside a guarded path (D6), `brain/scripts`, a dot-folder, or `workspaces/` is refused with a log line. | Per-duty minimal defaults. | The union covers every built-in duty on an un-reseeded vault; it is already far narrower than today. Per-duty narrowing can follow. *Amended 2026-09-28: it did not — the reflect duties' promotions need `brain/memory/feedback/` and `MEMORY.md`, now per-duty built-in writes (`2026-09-28-reflect-memory-writes-design.md`).* |
| D6 | **Both hosts: guard the persona trust files.** Before the child starts, `persona/duty-guard.js snapshot` copies `persona/IDENTITY.md`, `duties/`, `routines/`, `autoapply.json`, `flag-closer/`, `repos.json` and records `ledger.jsonl`'s size. After the child, `check` restores any added, changed or removed guarded file, keeps the duty's version under `persona/journal/logs/guard-<ts>/`, truncates `ledger.jsonl` to its old size plus appended `filed` events only, adds a `- [ ] <date> duty '<slug>' wrote guarded file(s) … — restored (guard)` flag to STATE.md, and sends one OS notification. | Restore from git. Diff the whole vault. | The trust files are gitignored. The user edits the vault while duties run, so a whole-vault diff cannot tell whose write it was; a small named set can be restored exactly. |
| D7 | **The snapshot lives outside every duty's reach**: `<config home>/agenticos-duty-guard/<slug>/` (the folder holding `agenticos.json`). | `$TMPDIR`. | Codex's workspace-write sandbox can write `$TMPDIR` and `/tmp`; neither host's duty can write the config home. |

## 3. What already exists (at `0e951f3`)

- `persona/run-duty.sh:75` `PERSONA_TOOLS` default; `:207-217` the two runner branches (`AOS_HEADLESS=1` on both).
- `routines/run-routine.js:99-104` passes a duty routine's `tools:` as `PERSONA_TOOLS` (`{{NODE}}`/`{{VAULT}}` expanded).
- `persona/ledger.js:89-91` headless refusal of `approved`/`auto-applied`; `persona/recipe.js` the git option refusals.
- `lib/paths.js` `dailyNotePath()`, `claudeConfigDir()`, `AOS_CONFIG`; `persona/watchdog.js` `osNotify()` and the
  `## Flags` insertion that `reconcileFlags()` uses.
- Writes made *by allowlisted scripts* inside a duty: `persona/{queue,ledger}.jsonl`, `persona/proposals/*.md`,
  `brain/_index/proposals/*.html`, `brain/_index/.sitrep-state.json` — all inside the D4 roots.

## 4. Design

- `brain/scripts/persona/duty-guard.js` (CommonJS, no deps), verbs:
  `scope --host claude|codex --tools <list> [--writes <list>]` → prints the final `--allowedTools` value (claude) or
  one `--add-dir` path per line (codex); `snapshot <slug>`; `check <slug>` → exit 0 clean, 4 restored (prints the
  paths). Pure helpers (`scopeFor`, `claudeTools`, `codexDirs`, `diffSnapshot`) are unit-tested.
- `run-duty.sh`: no node or no `duty-guard.js` → the duty does not run; `snapshot` before the child (no snapshot → no
  run); Claude branch passes `--permission-mode dontAsk` and the two `scope --host claude` lines; Codex branch uses
  `-C "$VAULT/persona"`, the empty `writable_roots` and the `--add-dir` lines; `check` right after the child, before
  anything else runs from the vault, so a restored run ends `FAILED (guard exit 4)` with no helper beat.
  The default `PERSONA_TOOLS` and the template `tick`/`reflect-daily` routines drop `Write,Edit` and `git log`/`diff`.
- `routines-store.js` / the HUD's `src/data/routines.ts`: `writes` (flow array, duty only) in `KEY_ORDER` and
  validation; `run-routine.js` passes it as `PERSONA_WRITES`.
- `lib/pin-root.js` `assertPinned({ root, file, fileRel, within, withinRel })`; called from ledger, proposal-html,
  tick, reflect.
- Docs: `docs/chief-of-staff.md` (what a duty may write, per host), `vault-template/brain/routines/README.md` (`writes:`).

## 5. Host parity

1. **Entry point.** None new: every duty run already goes through `run-duty.sh` on both hosts.
2. **Hooks.** No hook changes; Codex users re-trust nothing.
3. **Model calls.** None added. The runner still picks `persona.runner`.
4. **Session data.** None read.
5. **MCP.** No new tool.
6. **Degradation.** A write outside the scope fails for that tool call (Claude: permission denied; Codex: sandbox
   `EPERM`) and the duty continues; a guarded change is restored and flagged on both hosts.
7. **Docs.** `docs/chief-of-staff.md`, the routines README; no command or skill counts change.

| Mode | How the user invokes it | What runs | What they see if it can't |
|---|---|---|---|
| Claude Code only | nothing new; scheduled duties | scoped `Edit(…)` rules, git write-out denied, pinned script roots, guard | the denied tool call fails inside the run; a guarded change → restored, FAILED flag, notification |
| Codex only (plugin · direct) | nothing new; scheduled duties | cwd `persona/` + `--add-dir` roots, pinned script roots, guard | sandbox refuses the write; a guarded change → restored, FAILED flag, notification |
| Both | nothing new | the host `persona.runner` resolves to | as above for that host |

The one difference: under Codex the persona trust files in `persona/` (`IDENTITY.md`, `duties/`, `autoapply.json`,
`flag-closer/`, `repos.json`, `ledger.jsonl`) are writable *during* a run and restored after it (D4/D6); under Claude
they are never writable. Routine files are not in that set: a live vault keeps every routine, the heartbeat's command
`argv` included, in `brain/routines/` (the template's `persona/routines/` is copied there at install), which is denied
under Claude and outside every Codex root. Closed fully by moving trust state out of the vault (below).

## 6. Testing

- `test/duty-guard.test.js`: scope building (bare Write/Edit stripped; `Write(…)` stripped; refused `writes:`
  entries; daily-note folder from the layout; vault-root layout grants nothing); snapshot/check restores an edited,
  added and deleted guarded file, keeps the duty's copy, trims a forged `approved` ledger line but keeps `filed`.
- `test/run-duty.test.js`: fake claude sees the scoped `--allowedTools` and the deny rules; fake codex sees
  `-C <vault>/persona` and the `--add-dir` list; a fake duty that edits `persona/routines/x.md` ends `FAILED guard` with
  the file restored and a STATE.md flag.
- `test/pin-root.test.js`: `--root`/`--file`/file arguments outside the vault exit 2 under `AOS_HEADLESS=1` (real child
  processes) and still work without it.
- Live probes on scratch vaults outside the config dir (done 2026-09-23, owner-approved): `codex exec` with the D4 argv
  (persona/ and `brain/_index` writable; `brain/scripts`, `brain/memory`, `workspaces/`, `.obsidian/`, `.git/hooks`
  and the config home refused; `$TMPDIR` and `/tmp` writable, hence D7), and `claude -p` on haiku with the D1/D2 flags
  (scoped writes allowed through either vault path form, deny beat allow, `git log --output=` refused, unlisted paths,
  `touch` and writes outside the vault refused). A vault under a `.claude/` folder refuses every write regardless of
  rules — Claude Code protects that folder — so probes and users' vaults must live elsewhere.

## 7. Out of scope (the rest of Proposal 1)

Moving the runtime and the trust state out of the vault (closes the Codex window in which a trust file is changed
during a run and read before the check restores it, e.g. by a second duty starting meanwhile); structured checks in place of
shell recipes; `brain/_index` stays writable to Codex duties (BRAIN.md injection persistence, the S5 class);
prompt routines keep their own `tools:` (read-only by default).
