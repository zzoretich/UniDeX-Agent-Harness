# Mandatory prerequisites: Obsidian, Ollama, python3 — design

Date: 2026-09-22 · Branch: `feat/mandatory-prereqs` · Verified against `b2f6a8f`

## 1. Problem

`aos init` has one unconditional hard gate (Node ≥ 20) and one conditional gate (a logged-in host
CLI, waived by `--provider none`). Obsidian is detected and printed as "not detected (optional)",
Ollama is probed and printed as "informational", and python3 is checked only when `--cost` is
passed. `aos doctor` mirrors that: the Obsidian row is `warn` and only checks the HUD bundle inside
the vault, the Ollama row is `info`, and the python3 row exists only when the cost module is on.

The product is designed around all three: the HUD is the vault's front door, the local provider is
where background work is meant to run, and the cost module needs an interpreter. An install that
completes without them produces a vault that half works and a doctor that says it is healthy. The
README already declares `git` required while nothing checks it, so the docs and the installer have
drifted apart on what "required" means.

This change makes Obsidian, Ollama and python3 ≥ 3.9 hard prerequisites of `aos init` and `fail`
rows in `aos doctor`, with test seams so CI can still rehearse an install on a bare runner.

## 2. Decisions

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| D1 | "Installed" means the binary or app bundle is present: Obsidian via the existing `obsidianDetected()` probe, Ollama via `ollama` on PATH or `Ollama.app` under `/Applications` or `~/Applications`, python3 via `python3 --version` ≥ 3.9. | Gate on Ollama *answering* on `127.0.0.1:11434`. | The ask is about installing. A freshly installed Ollama may not be serving yet, and the provider chain already handles an idle one. Reachability stays a runtime signal (D5). |
| D2 | The three checks run unconditionally in the `init()` preflight, before any write, and throw `CheckFailed` (exit 1) with an install hint. `--provider none` does not waive them. | Waive with `--provider none`, as the host-CLI check does. | `--provider none` means "no model calls", not "no tools". Obsidian and python3 have nothing to do with providers. |
| D3 | Each check gets one env seam, mirroring `AOS_CLAUDE_BIN`: `AOS_OBSIDIAN_APP`, `AOS_OLLAMA_BIN`, `AOS_PYTHON_BIN`. Set to a path, that path is used; set to the empty string, the tool is treated as absent; unset, the normal probe runs. | A single `AOS_SKIP_PREREQS=1` bypass. | A bypass is a hole that ships to users. A per-tool path seam lets tests and the rehearsal prove the *positive* path against a fixture, exactly as the fake `claude` does today. |
| D4 | `--no-obsidian` keeps its current meaning (skip building or downloading the HUD bundle) and its help text says Obsidian itself is still required. | Remove the flag. | The rehearsal and offline installs need to skip the `npm run build` and the release download. That step is about the bundle, not the app. |
| D5 | `aos doctor` gains `obsidian app`, `ollama installed` and an unconditional `python3 >= 3.9` row, all `fail`. `ollama reachable` is promoted from `info` to `warn` when the probe fails (still `info` when skipped). The `obsidian plugin` bundle row and the `cost analyzer` row are unchanged. | Promote `ollama reachable` to `fail`. | Doctor exit 1 for a daemon that is installed but stopped would make `aos doctor` red on every laptop after a reboot. |
| D6 | The rehearsal proves the positive path: `first-run.sh` points `AOS_OBSIDIAN_APP` at a temp directory and `AOS_OLLAMA_BIN` at a new `cli/fixtures/fake-ollama.sh`; python3 is real (present on both CI images). | Add an Ollama service container to CI. | The gate is "installed", not "answering"; a fixture is enough and keeps CI network-free. |
| D7 | `cli/cost-cmd.js` `pythonVersion()` honours `AOS_PYTHON_BIN` too, so `aos cost enable` and `init` agree on which interpreter they test. The redundant `--cost` python gate in `init` is dropped (the unconditional one covers it); the cost-sources check stays. | Leave `cost-cmd.js` alone. | Two functions probing "python3" with different seams would disagree in tests. |
| D8 | No new config keys. The detected paths are not recorded in `agenticos.json`. | Record `obsidian.app` and `ollama.bin` like `claude.bin`. | Nothing reads them. `claude.bin` is recorded because hooks spawn it; nothing spawns Obsidian or Ollama by path. |
| D9 | `aos upgrade` is not gated. | Re-run the three checks on upgrade. | Upgrade re-vendors scripts on a vault that already passed init; doctor is the place to notice a tool that has since gone missing. |

## 3. What already exists (at `b2f6a8f`)

- `cli/aos.js`: `which()` (`:122`), `run()` with `allowFail` (`:106`), `python3Version()` / `python3Ok()`
  (`:180-185`, no seam), `obsidianDetected()` (`:186-189`, no seam, used only by the preflight log line
  `:804`), `httpProbe()`, `ollamaEndpoint()`, `ollamaProbeSkipped()` (`:190-204`), `claudeBin()` with the
  `AOS_CLAUDE_BIN` seam (`:135`).
- `init()` preflight `:777-815`: Node gate, host-CLI gates, the Obsidian log line, the `--cost` python gate,
  the Ollama log line.
- `doctor()` `:272-380`: `add(name, ok, detail, level)`; exit code keys off `level === 'fail'` only (`:370`).
  Rows `obsidian plugin` (`warn`, `:336`), `ollama reachable` (`info`, `:355-357`), python3 inside the
  `cfg.cost.enabled` guard (`:358-363`).
- `cli/cost-cmd.js` `pythonVersion(exec)` (`:36-43`) with `MIN_PY = [3, 9]`; `enable()` throws on `!py.ok`.
- `cli/aos.test.js` `sandbox()` (`:15-43`) sets `AOS_CLAUDE_BIN`, `AOS_NPM_BIN`, `OLLAMA_PORT: '1'`,
  `AOS_SKIP_OLLAMA_PROBE: '1'`; tests spawn the real CLI. Absence is simulated as `{ AOS_CLAUDE_BIN: '', PATH: emptyBin }`.
- `cli/rehearsal/first-run.sh`: `init --no-obsidian --provider none` with `AOS_CLAUDE_BIN` pointing at
  `cli/fixtures/fake-claude.sh`; CI runs it on ubuntu and macOS with nothing but Node installed.
- Docs: README badge (`:14`), Prerequisites table (`:60-73`), install step 1 (`:98`), flags (`:108`),
  providers paragraph (`:273`); `docs/install.md` `:3, :18, :38, :44`; `docs/acceptance.md` §0;
  `docs/cost.md` `:6, :12`; `extras/ollama/README.md` `:1-4`.

## 4. Design

### 4.1 Probes and seams (`cli/aos.js`)
`obsidianApp()` returns the detected path or null: `AOS_OBSIDIAN_APP` if defined (empty → null,
else the value when it exists), otherwise the current platform probe reshaped to return the path it
found. `ollamaBin()` follows the same shape with `AOS_OLLAMA_BIN`, then `which('ollama')`, then the
macOS app bundle locations. `pythonBin()` returns `AOS_PYTHON_BIN` when defined (empty → null) else
`'python3'`; `python3Version()` runs that binary. `obsidianDetected()` is kept as `!!obsidianApp()`.
All three are exported for tests.

### 4.2 `init()` preflight
After the host-CLI block and before the `--cost` block:

```
const obs = obsidianApp(); if (!obs) throw new CheckFailed('Obsidian not found — install it (obsidian.md), then re-run aos init');
const oll = ollamaBin();   if (!oll) throw new CheckFailed('ollama not found — install it (ollama.com), then re-run aos init');
const py  = python3Version(); if (!python3Ok(py)) throw new CheckFailed('python3 >= 3.9 is required — ' + (py ? `found ${py.major}.${py.minor}` : 'python3 not found on PATH'));
```
The preflight log line becomes `preflight: obsidian <path> · ollama <path> · python3 <maj.min>`.
The Ollama endpoint line is unchanged except its fallback text no longer says "optional".

### 4.3 `doctor()`
Three new rows next to `node >= 20`: `obsidian app`, `ollama installed`, `python3 >= 3.9` (all
default level `fail`). The cost block keeps only the `cost analyzer` row. `ollama reachable` uses
`'warn'` on a failed probe with the detail `run \`ollama serve\``; the skipped branch stays `info`.

### 4.4 Rehearsal and fixtures
`cli/fixtures/fake-ollama.sh`: prints `ollama version is 0.0.0-fake` and exits 0. `first-run.sh`
creates `$TMP/Obsidian.app` and exports `AOS_OBSIDIAN_APP` and `AOS_OLLAMA_BIN`. The doctor
assertion in the rehearsal gains the three new `ok` rows.

### 4.5 Docs
README: badge text drops "Ollama optional"; Prerequisites rows for Obsidian, Ollama, python3 become
`required` with the exact check in the third column; install step 1 and the `--no-obsidian` flag
text; the providers paragraph no longer says "install Ollama later". `docs/install.md` mirrors
each. `docs/acceptance.md` §0 lists Ollama. `docs/cost.md` says python3 is checked at install.
`extras/ollama/README.md` intro says Ollama is required and these are the optional supervisors.

## 5. Testing

- `cli/aos.test.js`: `sandbox()` gains `AOS_OBSIDIAN_APP` (a created temp dir), `AOS_OLLAMA_BIN`
  (the fixture) and leaves python3 real. New init tests: each of the three set to `''` → exit 1 with
  the matching message and nothing written; `--provider none` still fails on a missing Obsidian.
  Doctor tests: the three `ok` rows; each `FAIL` row and exit 1 when its seam is empty; `warn ollama
  reachable` when the probe runs against `OLLAMA_PORT=1`.
- `cli/cost-cmd.test.js`: `pythonVersion` uses `AOS_PYTHON_BIN` when set.
- Unit tests for `obsidianApp()`, `ollamaBin()`, `pythonBin()` seam semantics (defined-empty vs unset).

## 6. Out of scope

A `git` check (README already says required; not asked for here). Forcing `provider: ollama` or
pulling a model at install. Recording tool paths in `agenticos.json`. Gating `aos upgrade`. Windows.
