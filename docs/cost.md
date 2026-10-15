# Cost module

Opt-in. Costs every Claude Code session from its transcript (the Python analyzer) and every Codex
session from the token counts in its rollout (priced in Node from a rate table; an estimate, since
Codex never reports dollars), and shows month-to-date spend in the Pulse COST row and the COST DETAIL
drawer section of the HUD. Runs on python3 3.9+ (stdlib only), which `aos cost enable` checks: since 2.0 python3 is
not an install prerequisite, and `aos doctor` checks it only while cost is on. Nothing leaves your machine — the
session-end hook runs the analyzer with `--no-api`.

The cost module prices your own sessions. What UniDeX's background work spends on its own is a separate ledger,
below.

## What background work spends

Every hosted call UniDeX makes for you (a background summary on Claude or Codex, a reasoner answer, a Chief of Staff
duty, a prompt routine, the graph's semantic pass, a cross-review) appends one row to
`brain/_index/provider-spend.jsonl`, with its `feature` (`duty:<name>`, `reason:<command>`, `routine:<slug>`,
`graph:semantic`, …), provider, model and USD: Claude reports its own cost, and Codex's is estimated from its token
counts (`brain/scripts/sdk/lib/codex-pricing.js`). Each family has its daily cap (`claude.perDayUsd` or
`codex.perDayUsd` for the hooks, `persona.perDayUsd`, `reasoner.perDayUsd`, `routines.perDayUsd`,
`graph.semantic.perDayUsd`, `crossReview.perDayUsd`); `aos status` and ⚙ Settings show today's spend against each.

- **Local calls are free and are not ledgered.** Under provider `local` (a new install's default since 2.0), background
  work runs on the model on this Mac. Each call is counted, per day and per feature, in
  `brain/_index/local-usage.json` (the last 30 days), which `aos local`, `aos status` and Settings ▸ Local engine read;
  it never touches `provider-spend.jsonl`, so a scan's hundreds of local calls cost the spend readers nothing. One
  exception: a routine run by the built-in local agent (`engine: local`) writes one `$0` row per run, with
  `provider: ollama` and its tokens. With the local model down,
  nothing falls back to a host unless `local.hostedFallback` is on (then under the hook caps above).
- **The Chief of Staff** runs on `claude-opus-5-5` on Claude Code or `gpt-6-sol` on Codex (a new install's models;
  [chief-of-staff.md](chief-of-staff.md#host-model-and-failover)). Its duties are capped per run (`persona.perDutyUsd`,
  or a routine's `budgetUsd`, enforced through `--max-budget-usd` on Claude Code; Codex has no per-run budget flag) and
  per day by **one** `persona.perDayUsd` over both hosts together: a duty that fails over to the other host counts
  against the same cap, and a capped day is skipped on both, never moved.
- **The hourly tick's quiet hours cost nothing.** Since 2.0 the tick is a local triage (`tick.js --triage`): when
  nothing that matters changed, the hour ends with no model call of any kind; a real change asks the local model
  (counted in `local-usage.json`) whether it merits a run, and only a woken Chief of Staff run is a hosted, ledgered
  duty.
- **The Go-local card** (the 2.0 update's question, and Settings ▸ Local engine ▸ Go local…) shows what background
  work spent in the last 7 days, from this ledger: hosted rows only, without the work that stays hosted (duties,
  prompt routines, Sessions, cross-review, teams).

## Enable / disable

```
aos cost enable [--budget <usd>] [--yes]   # checks python3, installs the analyzer into <vault>/brain/scripts/cost/,
                                           # sets cost.enabled=true, stores cost.monthlyBudget (optional)
aos cost disable                           # cost.enabled=false; the auto-cost stage reports "disabled"
```

Re-running `aos cost enable` without `--budget` keeps a budget you set earlier; `--budget` with
anything but a positive number is rejected. `cost.enabled` lives in `agenticos.json`;
`cost.monthlyBudget` lives in `<vault>/brain/config.json`.

## What you get

- At SessionEnd, `auto-cost.js` finds the session transcript under `<configDir>/projects/*/`,
  runs the analyzer, and appends the session's cost to `brain/_index/agent-runs/costs.jsonl`;
  `runs.jsonl` itself is never rewritten. Everything that shows a cost reads the two together and
  counts a session once, on its latest run, however many runs it has. Snapshots
  land in `brain/_index/cost/snapshots/` (gitignored). For a Codex session (the hook fired with
  `AOS_HOST=codex`) the rollout under `<codex home>/sessions/` is priced in-process instead and
  recorded with `cost_source: "codex-rollout"`; the model comes from the run record, the rates from
  `brain/scripts/sdk/lib/codex-pricing.js`.
- `node brain/scripts/auto-cost.js --backfill` costs every past session that still has a transcript.
- The Pulse COST row and the cost Fix Queue cards render only when cost is enabled and
  `cost.monthlyBudget` is set (a null budget hides them).

## Budget and calibration

Transcript-derived costs exclude the platform's hidden system-prompt baseline, so they are a
consistent underestimate of the billed figure. `node brain/scripts/cost-budget.js` shows the
anchored month-to-date; `--anchor <usd>` records the real billed number you read from your
account page (the prompt placeholder is `0.00`), and every anchor recalibrates the scaling
factor from the interval since the previous one. `--budget <usd>` overrides the monthly budget
for the anchored ledger; the default comes from `cost.monthlyBudget`.

## Pricing

`brain/scripts/cost/pricing.json` (from `extras/cost/pricing.json`) lists USD per million tokens with a `rates_as_of`
date and the page they were checked against (Anthropic's published prices; `claude-opus-5-5`, the Chief of Staff's
Claude model, among them). Verify the rates before trusting dollar figures; unknown model ids fall back to
`default_model` and are flagged in the report. Cache reads use one multiplier (`read_mult`) for every model, so a model
whose cache reads are billed lower (Opus 5.5's are 0.05x) is overestimated there.

The Brain hub's estimates before Merge with AI or a sweep ("about $0.004 · haiku · Claude") price Claude
from a copy of these rates in `brain/scripts/sdk/lib/model-pricing.js` (the runtime never reads this file).
`brain/scripts/test/model-pricing.test.js` pins that copy to the repo's `extras/cost/pricing.json`, so a rate
changed here fails the test until both agree. Codex keeps `brain/scripts/sdk/lib/codex-pricing.js`, with OpenAI's
published rates (`gpt-6-sol`, the Chief of Staff's Codex model, among them); an id it does not list takes its longest
known prefix, then `gpt-5`'s rate.

## Privacy

Transcripts are read locally. The analyzer has one optional `count_tokens` API call (to split
co-loaded skills more precisely); it happens only when you run `analyze_transcript.py` by hand
without `--no-api` while `ANTHROPIC_API_KEY` is set and the `anthropic` package is installed. The
session-end hook always passes `--no-api`, so it never makes that call. Reports and snapshots stay
in the vault.

## Tests

`cd extras/cost && python3 -m unittest` runs the analyzer's own tests; CI runs the same lane on
every push to `main` and every pull request, on Ubuntu and macOS.
