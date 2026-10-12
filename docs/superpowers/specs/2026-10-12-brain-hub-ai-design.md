# UniDeX Brain, PR 4: AI merge drafts and the consolidation sweep — design

**Date:** 2026-10-12
**Status:** approved 2026-10-12 as written, on `feat/brain-hub-ai` (A1–A3 the user's picks; the live check per host makes real Claude and Codex calls, about $0.10). Extends the approved hub design (`2026-10-11-brain-hub-design.md`, D1–D25): this is its D21 and D22 made exact. *(user)* rows are the user's answers; the rest are proposed technical decisions. Mockups are private (canvas frames Merge, Health, Main, Map).
**Base:** `main` at `3f81434` (PR 3 #124, the To-Do e2e fix #126, the first-prompt inject fix #125). Runtime (`brain/scripts`, `cli`), `plugin/` and the generated `codex-plugin/`, the HUD, the app's surface rules.
**Scope:** Merge with AI (Review's M, Health's duplicate rows), the Consolidation sweep (Health), Consolidate with AI (a Map community, a Health cluster). Code comments cite `brain-hub D<n>` and `brain-ai A<n>`.

---

## 1. Problem

After PR 3 the hub finds sprawl but cannot fold it: on the real vault Health lists 50 duplicate pairs and 12 clusters, and Map shows communities made of one memory per release step. Review's M only compares two memories ("Keep the older one" / "Keep both"); combining them means editing files by hand and superseding the rest. `/consolidate-memory` writes a markdown proposal that nothing applies (`sdk/consolidate-memory.js`). The copy already promises the rest "in a later update" (`ReviewMode.ts:622`, `HealthMode.ts:12`).

## 2. Decisions

| # | Decision | Rejected |
|---|---|---|
| A1 | *(user)* **The merged memory replaces the oldest source in place:** the oldest (by `created:`, then path) keeps its path, so its `[[links]]`, pins, usage history and BRAIN.md place carry over; its title, description and body become the merged ones; `updated:` is bumped, `reviewed: true`, `pin: true` if any source was pinned; the others are superseded by it (D7). The dialog names the target ("keeps the older slug's links", as the canvas). | A new file with a new slug: breaks links and splits usage history. |
| A2 | *(user)* **Undo merge:** before writing, `merge` saves the winner's old text and every source's hash in `brain/_index/memory-merges/<id>.json`; `aos memory unmerge PATH --expect HASH` puts the winner's text back and restores the others (D7's Restore). It refuses if the merged memory changed since. Records older than 30 days are pruned at scan, as the canvas copy says. | Dropping "Undo": the winner's old text is overwritten, so Restore alone cannot bring it back. |
| A3 | *(user)* **Consolidate with AI** on a Map community or a Health cluster runs a **sweep scoped to those memories** (`sweep PATH…`, ≤ 50 paths). Its cards show in the panel and in Health's sweep card under the group's name. | One merge of every member: thirteen memories into one is rarely right, and a scoped sweep can still suggest merging a subset. |
| A4 | **No model, or a cap reached:** the same Merge dialog opens in **combine-by-hand** mode. The sources are side by side (D21) and the draft is prefilled without a model: the oldest's title and description, then each body under "From <title>". The dialog says why, and Save runs the same `merge`. The sweep is off, with the reason. | Only today's Compare: the user would still finish the merge in an editor. |
| A5 | **Estimate before, spend after, in the runtime:** `merge-draft --estimate` and `sweep --estimate` resolve the provider without calling it. They count input tokens (chars/4 plus a per-host overhead), price them, and report today's cap left. After a real call: Claude's `total_cost_usd`; Codex's priced tokens marked `estimated`; Ollama $0. A new `sdk/lib/model-pricing.js` holds Claude's rates, pinned by a test to `extras/cost/pricing.json`; Codex keeps `codex-pricing.js`. | Pricing in the HUD. Diffing the ledger around a call, which races with hooks. |
| A6 | **The sweep's model is the background one.** It uses `claude.model` (haiku) on Claude, or `codex.model` at `codex.effort` (low) on Codex, through `resolveProviderForRole({role:'reasoner'})` with a per-host model override. The feature is `reason:memory-sweep`, counted against the reasoner cap (D22: a whole-vault call outgrows the $0.05 hook per-call cap). | `reasoner.model` (Opus): a 30k-token sweep is about $0.45, near its $0.50 per-call cap; the canvas shows "about $0.06 · claude haiku". |
| A7 | **Merge draft provider chain** is the hook chain (D21, feature `memory-merge`): Ollama, else a logged-in `claude` (`--max-budget-usd claude.perCallUsd`), else Codex (low effort, daily cap). The answer carries `{provider, model}`, shown as "drafted by haiku · Claude". With only Ollama the sweep is off ("the sweep needs Claude or Codex"). Merging still works on Ollama. | The sweep on the 9B local model: it cannot hold the whole brain. |
| A8 | **Limits and escaping:** 2–6 live sources of any type (the winner's type wins, shown). Each body is capped at 8,000 characters in the prompt (24,000 in all; beyond that it is cut with a marker and the dialog says so). The reply uses a strict schema: `title` (one line, ≤ 120), `description` (≤ 200), `body` (≤ 16,000). Frontmatter goes through `yamlValue`; a reply's leading H1 or `---` line is dropped (the H1 comes from `title`). | Reusing `memory-writer.writeMemory`: no escaping, not atomic, no O_NOFOLLOW. |
| A9 | **`merge PATH… --into JSON --expect H1,H2,…`** takes one hash per path, in order: any changed source refuses (`CHANGED`, nothing written). The write order is the record, the winner (atomic), then each loser superseded. MEMORY.md is updated under one lock: the winner's line is rewritten with the new title and description, the losers' lines removed (D7's collapse; `supersede` today never touches the winner's line). Trail: `merged` for the winner (`from: [...]`, `record`), `superseded` per loser. BRAIN.md is rebuilt once. | One hash for the whole set: it cannot say which file changed. |
| A10 | **Sweep cards:** `merge` (2–6 paths and a proposed title), `archive` (1–10 paths), `retitle` (1 path, a new title, optionally a description). Every card says why. They are kept in `brain/_index/memory-sweep.json` with the hashes the sweep saw. A card is done or stale once a path is retired or changed (the files win). `sweep dismiss ID` hides it for good; a later run never re-suggests the same kind and paths. A new run replaces the open cards of its scope. Applying: Merge opens the Merge dialog on its paths (a second, per-click call); Archive confirms, then `archive`; Retitle runs `set` with a new `title` key (it rewrites the H1 and the MEMORY.md line; the slug stays). | Applying the whole sweep at once (D22: "each card applies through the same verbs"). "Rename" (the canvas word) suggests the file is renamed; slugs never change. |
| A11 | **Sweep input** is one line per live memory: path, type, status, age, use in 30 days, title, description, and the first 200 characters. The hub's duplicate pairs and clusters go in as hints. The cap is 120,000 characters (about 30k tokens); past it, memories in pairs and clusters go first, then unreviewed, then newest, and the card says "N of M memories looked at". | Whole bodies: about 4× the tokens for little gain. |
| A12 | **The HUD waits up to 120 s** for `merge-draft` and `sweep` (`DraftModal`'s precedent; the default is 60 s, `aosRun.ts:52`). Cancel drops the answer, and the dialog says the call may still be billed. | Streaming. Killing the child, which needs a new bridge call. |
| A13 | **Surface `brain`** gains exact argv rules: `merge-draft MEMORY{2–6} [--estimate] --json`; `merge MEMORY{2–6} --into JSON_OBJ --expect HASHLIST --json`; `unmerge MEMORY --expect HASH --json`; `sweep MEMORY{0–50} [--estimate] --json`; `sweep dismiss SWEEP_ID --json`; `set` admits `title`. `verified: true` stays; the live check runs before merge and its dated comment is extended. **SECURITY.md** gets a row for the two model calls: what is sent, to whom, the caps. | A new surface. |
| A14 | **`/consolidate-memory` keeps working and points at the hub** (Health's sweep, or `aos memory sweep --json` in a session). It still writes its proposal. | Retiring it. |

## 3. What already exists (verified at `3f81434`)

- **Provider:** `p.chat({system, prompt, schema, format, feature, timeoutMs})` returns text only (`provider.js:118, :176`). Usage comes from wrapping `deps.claudeCall` / `deps.codexCall` (`workspace-draft.js:253-259`). The hook chain is at `provider.js:233-274`; the reasoner (never Ollama) at `:288-328`. A cap is `ProviderUnavailable` `PROVIDER_CAP`, `none` is `PROVIDER_NONE` (`spend-ledger.js:19`). The hook family excludes `reason:` (`:61-62`). Codex uses strict schemas (`codex-cli.js:189-217`) and estimated cost (`:261`). Defaults: `claude` 0.05/0.5, `codex` 0.05/0.5 low, `reasoner` 0.5/5 (`config.default.json:13-15`).
- **Precedent:** `lib/workspace-draft.js`: caps (`:36-39`), strict schema (`:46`), `parseDraftReply` (`:173-192`), fallbacks per error code (`:239-245`), Codex in an empty temp cwd (`:255-258`). Its tests fake each host at the `claudeCall` / `codexCall` (fake spawn) / `ollama.chat` seams (`test/workspace-draft.test.js:96-124, :269`).
- **Memory ops:** `supersede` → `retire` (`memory-ops.js:382-417`) removes the loser's line only. `upsertIndexLine` (`memory-index.js:56`) does what `restore` does (`memory-ops.js:432-436`). `yamlValue`, `write` (atomic), `appendTrail`, `sha256`.
- **CLI:** `cli/memory.js` tables `VALUE_FLAGS`/`VERB_FLAGS`/`VERB_ARGS`/`USAGE` (`:36-58`). `cli/aos.js:1396` forwards value flags (`into` is already a global value flag, `:1412`).
- **HUD:** `BrainCtx.run` passes no timeout (`BrainTab.ts:214-228`). `MemoryVerb` and `memoryArgs` are in `brainModel.ts:907-985`, `touched()` in `BrainTab.ts:322-330`, `load.ts` `SINGLES`. `DraftModal` has the editable-draft pattern: `providerLabel`, `seq` cancel, close blocked while saving.
- **App:** `MEMORY_VERBS` in `surfaces.ts:151-163` (`memoryPaths` is the variable-length template). e2e model stubs: `installChatStubs`, `providerState`, `chatReply` (`harness.ts:282-336`; used by `spaces-writes.spec.ts:825-894`). The fixture is `provider: "none"`.

## 4. Design

**Runtime** (`lib/memory-merge.js`, `lib/memory-sweep.js`, `sdk/lib/model-pricing.js`, `cli/memory.js`):
- `merge-draft PATH… [--estimate] --json` returns `{estimate}` with `--estimate`, else `{provider, model, fields:{title, description, body}, winner, type, baseHashes, truncated, usd, estimated, mode}`. `mode` is `ai` or `by-hand`; on `none` or a cap it carries a `reason` and the no-model prefill (A4). It writes nothing.
- `merge PATH… --into JSON --expect HASHES --json` returns `{path, superseded, record, brainMd}`. `unmerge PATH --expect HASH --json` returns `{path, restored, brainMd}`.
- `sweep [PATH…] [--estimate] --json` returns `{run, suggestions, considered, of, usd, estimated, provider, model}`. `sweep dismiss ID --json` returns `{dismissed}`.
- The estimate shape is `{available, reason?, provider, model, tokensIn, usd, capLeft, cap}`.
- `set` gains `title`. The scan prunes merge records older than 30 days.

**HUD:** `views/brain/MergeModal.ts` follows the canvas Merge frame. Sources sit on the left. The draft on the right has an editable Title, Description and Body. The spend line reads "drafted by <model> · <host> · $x · today $y of $z", with an "estimated" mark for Codex. A "Saving will" list, Redraft, Cancel, and Save merged. The dialog opens from Review's M ("Merge into one…" next to "Keep the older one" / "Keep both"), Health's duplicate rows ("Merge with AI…"), and a sweep Merge card.
- Health gains the **Consolidation sweep** card: "last run …, N suggestions, N open", the estimate "about $0.06 · haiku" before running, Run a sweep, and per card Review / Dismiss (Archive and Retitle confirm first). Each cluster row gets "Consolidate with AI…".
- Map's community panel gets "Consolidate with AI…", and the panel shows that scope's cards.
- `BrainData.sweep` comes from `memory-sweep.json` (added to `touchesBrain`). `BrainCtx.run` takes an optional `timeoutMs`.
- A memory's history shows "merged from N" with **Undo merge**.
- Colour only for state; every action is a button; the dialog is labelled and traps focus.

## 5. Host parity

1. **Entry point:** the Brain tab on either host. `aos memory merge-draft|merge|unmerge|sweep` in any session or terminal. No new command, skill or MCP tool; `/consolidate-memory` (`$agenticos:consolidate-memory`, direct `$consolidate-memory`) gains a line pointing at the hub.
2. **Hooks:** none change, so nobody re-trusts under `/hooks`.
3. **Model calls:** both go through `provider.js` (A6, A7). There is no `claude` spawn of our own: the provider's `claudeCall` / `codexCall` run them.
4. **Session data:** none read; the batches already name their host.
5. **MCP:** no new tool.
6. **Degradation:** `none`, logged out, or a cap: combine-by-hand, and the sweep off with its reason (A4). Ollama only: the merge on Ollama, the sweep off (A7).
7. **Docs:** README Everyday commands (`aos memory merge-draft|merge|unmerge|sweep`); SECURITY.md (A13); `docs/app-smoke.md` items for Merge and the sweep, plus its `## Codex host`; COVERAGE rows; CHANGELOG; `plugin/commands/consolidate-memory.md`.

| Mode | How the user invokes it | What runs | What they see if it can't |
|---|---|---|---|
| Claude Code only | Brain: Review M → Merge into one…; Health → Merge with AI…, Run a sweep, Consolidate with AI…; `aos memory …` in a session | Merge: Ollama, else `claude -p` on `claude.model` (hook caps, `--max-budget-usd`). Sweep: `claude -p` on `claude.model`, reasoner cap. "drafted by haiku · Claude", real cost | `none`, logged out or a cap: combine-by-hand Merge; the sweep off with the reason; the estimate names the cap |
| Codex only (plugin · direct) | The same; `aos memory …` in a Codex session | Merge: Ollama, else `codex exec` on `codex.model` at `codex.effort` (the daily cap gates the start). Sweep: `codex exec`, reasoner cap. Cost marked "estimated" (codex-parity D5) | The same fallbacks; no per-call cap under Codex (known, documented) |
| Both | Either | `auto`: Merge Ollama → claude → codex; sweep claude → codex (`provider: codex` puts Codex first); each answer labelled by who answered | A host not logged in is skipped; the other answers |

No cell differs beyond the provider chain each host already has, and no parity gap widens.

## 6. Tests

- **Runtime:**
  - fake providers per host (Ollama, Claude, Codex through a fake spawn);
  - `none`, a cap at resolve and mid-call;
  - a malformed reply (nothing written);
  - escaping (a title with `: # "` and a body opening with `---`);
  - `--expect` per path, unmerge (and its refusal after an edit);
  - the winner's MEMORY.md line rewritten and the losers' removed;
  - sweep: scoping, the input cap order, dismiss never re-suggested, stale cards;
  - prices pinned to `extras/cost/pricing.json`;
  - argv rules.
- **App:**
  - `write-policy` cases;
  - brainModel parsers, the prefill, card states;
  - e2e: a merge with the stubbed `claude` (Save, then the files: winner, losers superseded, MEMORY.md, trail); combine-by-hand under `none`; Undo merge; a sweep card (Retitle, Archive, Dismiss); a Codex-only variant (by hand; "the sweep needs Claude or Codex" naming Codex).
- **Live check per host,** on a vault copy (PR 3's setup):
  - one merge of a Claude Code batch's pair and one of a Codex batch's pair through the page's argv;
  - admitted with the surface on, refused off;
  - the diff matching the preview, and Undo restoring it byte for byte.

## 7. Out of scope

Review's "Merge all N with AI…" batch button; renaming slugs; streaming; scheduled sweeps (a routine could run `aos memory sweep` later); merging feedback drafts; a release.
