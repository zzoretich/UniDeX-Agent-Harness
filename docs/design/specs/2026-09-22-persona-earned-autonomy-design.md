# Persona earned autonomy — design

Date: 2026-09-22 · Branch: `feat/persona-earned-autonomy` · Verified against `786b94f` · Slice 4 (the last) of
`docs/design/plans/2026-09-22-persona-heartbeat.md`

## 1. Problem

The interview decided "no autonomy until earned": a class of change the user has approved several times
unchanged may be proposed for the auto-apply list, and only the user adds it. Three pieces of that ladder
exist as dead ends. `recheck.js --record` writes `persona/flag-closer/confirmations.json`, the counters the
auto-apply gate needs, and nothing calls it — the skill forbids it during a review and the monitor duty it
names never got the call. The ledger records `kind` and `target` but not the proposal's `autoapply_class`,
so no track record per class can be computed. The flag-closer's auto-apply lane commits changed paths but
never ledgers `auto-applied` nor deletes the proposal, so an auto-applied change would be invisible to the
watchdog's verify and to the next reflect. Today the ledger is empty, `autoapply.json` is `{ "classes": [] }`,
and no confirmations file exists: the ladder must be correct while the record is thin, and do nothing.

## 2. Decisions

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| D1 | The recipe runner moves into the vendored runtime: `brain/scripts/persona/recheck.js` (module and CLI) owns `runRecipe` (built on `ledger.runRecipe`: present → STILL-VALID, gone → STALE, error → RECIPE-ERROR), `loadConfig`, `gateAutoApply`, `recheck(review, root, { record })` and a new `record({ root, now })`. The plugin's `scripts/recheck.js` is deleted; `SKILL.md` step 2 calls `RECHECK = <vault>/brain/scripts/persona/recheck.js`, the way it already calls `LEDGER` and `BACKLOG`; `flag-closer.test.js` imports the brain copy. | Keep the plugin copy and have `tick.js` reach it through `brain/scripts/plugin/skills/…` (vendored for Codex) or a shim with three candidate paths. | The tick runs from the vendored runtime; a sibling of `ledger.js` is the one path that exists in the checkout, the vendored copy and the tests. The skill already depends on two vault scripts, so a third adds no new failure mode. `tools/export-scrubs.js` still names the plugin file, but the legacy vault directory it exported from is gone, so the export is inert for it — left as is. |
| D2 | `recheck.js record` reads `persona/proposals/*.md` itself (frontmatter through `backlog.js`'s parser, now exported), runs each recipe with the vault as cwd, and updates `confirmations.json` **at most once per local day**: `{ schema: 1, recordedDay, slugs: { <slug>: n } }` where STILL-VALID increments and anything else resets to 0; slugs no longer pending are dropped. A legacy flat `{ slug: n }` file is read as `slugs`. `tick.js precheck` calls it first, before the signature compare, inside try/catch; its result rides in the precheck's JSON line (`confirmations: { recorded, day, slugs }`). | Record on every hourly precheck; record in `beat`. | The gate's "2 consecutive confirmations" was designed for a daily monitor run: two days in `## Pending Proposals` for the user to object. Hourly counting would make it two hours. `beat` only runs when the vault changed; a quiet day would record nothing. |
| D3 | Every ledger event may carry `class` (the proposal's `autoapply_class`, kebab-case, `--class` on the CLI); `verify` copies it from the approval onto `verified` / `regressed`. `summary` gains `byClass` over **all** records, not the window — `{ filed, approved, rejected, autoApplied, verified, regressed, staleDropped }` per class — and a pure `autoapplyCandidates(byClass, { minVerified, whitelisted })`: classes with `verified ≥ minVerified`, `regressed === 0`, `rejected === 0`, not already whitelisted. `formatSummary` prints a `by class` line when any class exists. The reflect prompts and every flag-closer lane pass `--class` when the proposal has one. | Count approvals instead of `verified`; windowed counts; ignore rejections. | "Approved and zero regressions" can only be known after the verify window: an approval one day old is not evidence. `verified` is exactly "approved and held for a week". Trust accrues over months, so the window that suits proposal rates does not suit it. A rejection means the class produces changes the user refuses; auto-applying it is the wrong lesson. |
| D4 | Config: `persona.autoapply: { minVerified: 3 }` in `config.default.json`, mirrored into `aosConfig.ts`. `reflect.js inputs` gains an `autoapply` section: `classes` (from `persona/autoapply.json`), `minVerified`, `candidates` (D3, minus any class with an open or rejected `autoapply-<class>` proposal in the ledger). | Let the prompt read `autoapply.json` and count. | The pack is where the deterministic evidence goes (slice 3's D3); the model files, it does not count. |
| D5 | Both reflect prompts: when `autoapply.candidates` is non-empty, file one proposal per candidate (counted against the nightly cap of two), slug `autoapply-<class>`, `kind: self`, `target: persona/autoapply.json`, no `autoapply_class` of its own, `recheck: ! grep -Fq <class> persona/autoapply.json`, and a What that is the exact new file contents. The Why cites the class stats. | A dedicated proposal type or a separate autoapply lane in the review. | The interview wanted the user to approve it "like any other proposal"; the What is a whole-file replacement, so approval applies it exactly. |
| D6 | `SKILL.md` Approve lane: a changed path on the never-`git add` list (`autoapply.json` is one) is applied and verified but not staged; the commit names only the ledger and the proposal. Step 7 becomes a real lane: an eligible item (class whitelisted, STILL-VALID, ≥ 2 recorded confirmations, no never-add path, What applies cleanly) is applied, its recipe re-run expecting nonzero (else stop, report, no commit), ledgered `auto-applied … --class --recheck --by flag-closer`, and committed with the ledger and the proposal removal; step 8 reports each. | Auto-apply from `reflect-daily` at night. | The nightly duty runs on haiku under an allowlist without git verbs and a "never commit" invariant; the review session is where a What gets applied and verified by a model with the user present. The lane stays dormant until a class is whitelisted through D5. |
| D7 | `ledger.verify` already treats `auto-applied` as applied; a test pins it (an `auto-applied` record with a recipe is verified or regressed like an approval), the `regressed` signal reaches the tick unchanged. | — | Confirms item 4 of the plan rather than re-implementing it. |
| D8 | While the ledger is thin the ladder is inert by construction: `byClass` is empty, `candidates` is `[]`, the lane finds nothing eligible, and `record` writes a confirmations file with no slugs. The first proposals filed with a class start the count; the third `verified` of a class, weeks later, is the first candidate. Nothing changes the review verbs, the HUD or the duty set. | Seed a class or lower the bar to bootstrap. | The interview's rule; a lower bar buys nothing today because no proposal has been filed. |

## 3. What already exists (at `786b94f`)

- `plugin/skills/persona-flag-closer/scripts/recheck.js`: `runRecipe`, `loadConfig` (`persona/autoapply.json`), `gateAutoApply` (whitelist + STILL-VALID + ≥ 2), `recheck` with `--record` writing a flat `{ slug: n }`; only the test calls `record`. `collect.js` already parses `autoapply_class` (`:73`); `render-digest.js` shows the auto-apply column.
- `brain/scripts/persona/ledger.js`: `EVENTS` has `auto-applied` (`:26`), `APPLIED` (`:30`) includes it, `append` (`:66`) keeps `kind`, `target`, `by`, `recheck`, `commit`, `note` — no class; `runRecipe` (`:78`); `verify` (`:106`) base record `{ slug, kind, target, by }`; `summary` (`:127`).
- `brain/scripts/persona/tick.js`: `precheck` (`:139`) writes state and prints `{ changed, changes, since }`; `run-duty.sh` `:172-181` runs it before the model with the vault as `--root`.
- `brain/scripts/persona/reflect.js` `inputs` (`:223`); `backlog.js` `parseFrontmatter` (`:26`, not exported).
- `vault-template/persona/duties/{reflect,reflect-daily}.md` file proposals and ledger `filed` with `--kind --by --target`; `interview.js` re-renders `duties/*.md` on every run and keeps `autoapply.json`.
- `docs/chief-of-staff.md` `## Self-improvement` ends with "What is still to come (slice 4 …)"; the layout table calls `autoapply.json` "the dormant auto-apply whitelist".

## 4. Design

### 4.1 `brain/scripts/persona/recheck.js`
`node recheck.js <review.json> [--record] [--root <vault>]` (the skill's step 2, unchanged semantics) and
`node recheck.js record [--root <vault>]` (the tick; prints `{ recorded, day, slugs }`). `record` lists
`persona/proposals/*.md` (README excluded), parses `slug` (frontmatter, else the filename) and `recheck`, and
skips the write when `recordedDay` is today (`recorded: false`). A proposal without a recipe counts 0.
Exit 0 on every path but usage (2); errors go to stderr.

### 4.2 `ledger.js`
`CLASS_RE = /^[a-z0-9][a-z0-9-]{0,40}$/`; `append` writes `class` when given; `verify` copies `a.class`;
`summary` adds `byClass` and `candidates` is computed by the exported `autoapplyCandidates`.

### 4.3 `tick.js`, `reflect.js`, config
`precheck`: `const confirmations = recordConfirmations(deps, now)` (try/catch, `deps.recheck` injectable) →
returned and printed. `inputs`: `autoapply: { classes, minVerified, candidates }` with `classes` from
`persona/autoapply.json` (missing or corrupt → `[]`, one stderr line). `config.default.json` and `aosConfig.ts`:
`persona.autoapply.minVerified: 3`.

### 4.4 Prompts, skill, docs
`duties/reflect.md` and `duties/reflect-daily.md`: the D5 paragraph, and `--class <autoapply_class>` on `filed`.
`proposals/README.md`: `autoapply_class` is how the ladder counts, `class` in the ledger, the `autoapply-<class>`
proposal shape. `SKILL.md`: `RECHECK` path, D6 lanes, `--class` on every ledger call. `docs/chief-of-staff.md`:
step 6 **Earn** in `## Self-improvement` replacing the "still to come" paragraph, the `auto-applied` event and
`class` under `## Proposals`, the `autoapply.json` and `flag-closer/confirmations.json` rows in the layout
table. README: the persona paragraph gains one clause. Plan file: slice 4 boxes ticked.

## 5. Testing

- `recheck.test.js` (new, brain): verdict mapping; `loadConfig` missing, corrupt, present; `gateAutoApply` at 1
  and 2 confirmations; `recheck` with and without `record`; `record` increments, resets on STALE, drops a gone
  slug, is a no-op the second time the same day and counts again the next day, reads the legacy flat file,
  tolerates a missing proposals dir; CLI verbs and exit codes. Fixtures at mid-day UTC.
- `flag-closer.test.js`: the same assertions through the brain import; `collect` and the digest unchanged.
- `ledger.test.js`: `class` validated and written, absent when not given; `verify` copies it and judges an
  `auto-applied` record; `byClass` all-time; `autoapplyCandidates` at 2 and 3 verified, with a regression, a
  rejection, an already whitelisted class; `formatSummary` line.
- `tick.test.js`: `precheck` records once per day, never throws when `recheck` fails, prints the field.
- `reflect.test.js`: `autoapply` section with an empty vault, with a whitelist, with a candidate, minus an
  open or rejected `autoapply-<class>`.
- `aosConfig.test.ts` mirror; `persona-interview.test.js` and `cli/vault-template.test.js` still green with the
  prompt edits; `run-duty.test.js` tick helper unchanged. `npm run gate`, `npm test`, first-run rehearsal.

## 6. Out of scope

A new duty; changing the review verbs; HUD work; auto-apply outside the review session; expiring
confirmations; the dead export-scrub entries for the removed plugin file; Windows.
