# Cost module

Opt-in. Costs every Claude Code session from its transcript (the Python analyzer) and every Codex
session from the token counts in its rollout (priced in Node from a rate table; an estimate, since
Codex never reports dollars), and shows month-to-date spend in the Pulse COST row and the COST DETAIL
drawer section of the HUD. Runs on python3 3.9+ (stdlib only; an install prerequisite, so `aos init` already checked it); nothing leaves your machine — the
session-end hook runs the analyzer with `--no-api`.

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

`brain/scripts/cost/pricing.json` lists USD per million tokens with a `rates_as_of` date.
Verify the rates before trusting dollar figures; unknown model ids fall back to
`default_model` and are flagged in the report.

The Brain hub's estimates before Merge with AI or a sweep ("about $0.004 · haiku · Claude") price Claude
from a copy of these rates in `brain/scripts/sdk/lib/model-pricing.js` (the runtime never reads this file).
`brain/scripts/test/model-pricing.test.js` pins that copy to the repo's `extras/cost/pricing.json`, so a rate
changed here fails the test until both agree. Codex keeps `brain/scripts/sdk/lib/codex-pricing.js`.

## Privacy

Transcripts are read locally. The analyzer has one optional `count_tokens` API call (to split
co-loaded skills more precisely); it happens only when you run `analyze_transcript.py` by hand
without `--no-api` while `ANTHROPIC_API_KEY` is set and the `anthropic` package is installed. The
session-end hook always passes `--no-api`, so it never makes that call. Reports and snapshots stay
in the vault.

## Tests

`cd extras/cost && python3 -m unittest` runs the analyzer's own tests; CI runs the same lane on
every push to `main` and every pull request, on Ubuntu and macOS.
