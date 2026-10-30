# Proposals

Guarded changes wait here for the user's sign-off. One file per proposal, `YYYY-MM-DD-<slug>.md`, with YAML frontmatter:

    ---
    slug: <kebab-case; must match the filename after the date prefix>
    filed: YYYY-MM-DD
    target: <one line — what the change touches; mark guarded targets "(guarded)">
    recheck: <ONE /bin/sh command. Exit 0 = the finding is still present (proposal
              still valid). Nonzero = stale. Under 15 s, read-only, no network. It
              re-runs the ORIGINAL check that found the problem.>
    kind: <optional; self (default) | vault | workflow | product — self and vault are applied on
          approval; workflow and product are ideas for the user and go to persona/backlog.md when accepted>
    surface: <product proposals only: cli | plugin | brain | hud | vault-template | docs — where the
          change would live, so a feature run can start from the backlog entry>
    changes: |
      [{"path":"persona/PLAYBOOK.md","op":"replace","base":"sha256:<64 hex>","content":"<exact new text>"}]
    ---

    # <Title — one line the user recognises>

    **[Open the proposal in browser](file:///<vault>/brain/_index/proposals/<date>-<slug>.html)**

The `recheck` must stay inside the read-only grammar, or nothing runs it and the review shows RECIPE-ERROR with the reason: commands from `true false exit test [ grep egrep fgrep ls wc head tail cat cmp diff cut tr stat git` (git only as `git [-C <dir>] [--no-pager] log|diff|show|status|ls-files|rev-parse|rev-list|cat-file|merge-base|describe …`, without `-c`, `--output`, `--ext-diff` or `--textconv`), joined by `|`, `&&` or `||`, optionally led by `!`, with `$HOME` as the only expansion. No `;`, `&`, redirections, `$(…)`, backticks, comments or other programs. `node brain/scripts/persona/ledger.js run-recipe '<recipe>'` shows whether a recipe passes.

Every proposal also exists as an HTML page. `brain/scripts/persona/proposal-html.js <file>` renders it into `brain/_index/proposals/` and writes the link line under the title; run it right after filing (the vault scan renders anything missed). Never write or edit the link line by hand. The page stays after the proposal is decided, so the Proposals tab can still open it from the backlog and the history.

Body sections, in order: **What** (the exact change, as a diff or full replacement text), **Why** (evidence from the journal or feedback memories), **Risk** (what could go wrong), and **Premises** — what was verified versus assumed:

    ## Premises
    | Premise | Status | Evidence |
    |---|---|---|
    | <claim the fix depends on> | VERIFIED | <how checked, with path/date> |
    | <claim taken on faith> | ASSUMED | <why it is believed> |

Instruction proposal approval happens in the UniDeX Proposals tab. It shows the exact before and after text and binds the click to this proposal's digest and current file hashes. Older prose-only proposals remain readable but need an exact `changes` array before approval. The deterministic applier verifies with `recheck` and restores the prior files automatically if verification fails. The same tab offers Reject and Undo; Undo refuses to overwrite a file changed since approval. Inline instruction edits during active work follow the host's permission flow.

For `changes`, use 1–20 vault-relative paths. Operations are `create` (`base: null`, `content`), `replace` (`base: sha256:<64 hex>`, `content`), `patch` (`base`, exact unique `old` and exact `new`) or `delete` (`base`). Paths must be protected instruction files. Vault-relative paths and user-owned host paths (`host/claude-skills/<skill>/SKILL.md`, `host/codex-skills/<skill>/SKILL.md`, `host/claude-agents/<name>.md`, `host/codex-agents/<name>.toml`) are accepted. Dot segments, links, generated mirrors and other external paths are refused. The `base` hash is SHA-256 of the current file's bytes. `changes` is a JSON array in a YAML block scalar as shown above.

A `workflow` or `product` proposal is an idea, not a change the agent applies, so the review offers **accept** and **dismiss** instead: accept appends the proposal's What and Why to `persona/backlog.md` (through `brain/scripts/persona/backlog.js`, tracked) and deletes the file; dismiss deletes the file and records a `dismissed` ledger line, so the idea is not filed again.

Every outcome is appended to `persona/ledger.jsonl` through `brain/scripts/persona/ledger.js` (`filed` by the duty that wrote the proposal, `approved` / `rejected` / `stale-dropped` / `accepted` / `dismissed` by the review, `verified` / `regressed` by the watchdog once it has re-run an approved proposal's `recheck` for two weeks, `undone` when the user restores it). `ledger.js summary` is the agent's track record, per kind; both reflects read it before proposing. Nothing is ever applied without the user's decision: there is no auto-apply.

Guarded instruction territory: root CLAUDE.md, AGENTS.md, AGENTICOS.md; persona identity, playbooks, duties, routines, named agent skills and team TEAM.md; active feedback rules. Observation notes and feedback drafts stay outside this approval path. Code changes and product ideas use their existing review flows.
