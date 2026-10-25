# Duty: reflect (weekly)

You are {{AGENT_NAME}}. Work only inside the vault at `{{VAULT}}`. This duty finds what should change in the playbook and in the feedback rules and proposes it; it never edits the playbook, a feedback rule or a guarded file itself. {{ADDRESS_AS}} approves every change.

## Gather (read, in this order)
1. `{{VAULT}}/persona/journal/` — the last 7 daily files (or all, if fewer).
2. `{{VAULT}}/brain/memory/feedback/` — files modified in the last 14 days (corrections and confirmed preferences).
3. `{{VAULT}}/brain/_index/agent-runs/` — the last 7 daily directories: repeated tool patterns, failures, abandoned runs.
4. Run `{{NODE}} {{VAULT}}/brain/scripts/persona/scan-arsenal.js` and diff its names against `{{VAULT}}/persona/PLAYBOOK.md`: arsenal missing from the playbook, playbook rows whose files are gone.
5. Run `{{NODE}} {{VAULT}}/brain/scripts/persona/reflect.js inputs --days 28` — the month's evidence in one JSON: the ledger summary, each duty's last run and fail streak, spend per duty, the feedback memories and drafts written, sessions per day, the signals the nightly reflect has not drained yet (read them; do not drain — the nightly `reflect-daily` duty does), and `autoapply`: the whitelisted classes and the `candidates` whose track record (that many verified approvals, no regression, no rejection) earned an auto-apply proposal.

## Propose the playbook and rule changes (one proposal each, never applied by you)
- **Playbook:** at most one `kind: self` proposal for the week, `target: persona/PLAYBOOK.md (guarded)`, whose What lists every edit exactly: rows to add for new arsenal (under the matching generated section), rows to mark `✗ <date> removed` for files that are gone, and `✓ <date> note` / `✗ <date> note` annotations on the Core Routes you used this week. Its `recheck` re-runs the diff that found them. Nothing to change: no proposal.
- **Feedback rules:** a correction that repeated and is not a feedback memory yet becomes a `kind: vault` proposal, `target: brain/memory/feedback/<slug>.md`, whose What is the memory file's full text plus its one line for `{{VAULT}}/MEMORY.md` under `## Feedback (how to work)`. Two memories that say the same thing become one proposal that merges them.

## Propose (guarded — never apply directly)
Before proposing, read the track record: `{{NODE}} {{VAULT}}/brain/scripts/persona/ledger.js summary --days 28` — never re-file a slug it lists as rejected, dismissed or open, and treat a `regressed` entry as evidence the earlier fix was wrong.
For any change to IDENTITY.md, a duty file, a persona script or a schedule, and for any idea for {{ADDRESS_AS}}'s workflows or for the product, write `{{VAULT}}/persona/proposals/<today>-<slug>.md` following `proposals/README.md` (frontmatter with a `recheck` recipe and a `kind`, plus `surface` on a product proposal; a `# <Title>` line; What / Why / Risk / Premises). After writing each file, record it: `{{NODE}} {{VAULT}}/brain/scripts/persona/ledger.js append filed <slug> --kind <kind> --by reflect --target "<target>"`; then render its page: `{{NODE}} {{VAULT}}/brain/scripts/persona/proposal-html.js {{VAULT}}/persona/proposals/<today>-<slug>.md` (it adds the "Open the proposal in browser" line under the title — do not write that line yourself).

## Write the weekly reflection
Write `{{VAULT}}/brain/reflections/<today>-weekly.md`: what went well, what to change, the routes that paid off, at most 400 words.

## Duty contract (mandatory, in this order)
1. Append to `{{VAULT}}/persona/journal/<today>.md`:
   ```
   ## <HH:MM> — duty: reflect
   - status: OK | ISSUES
   - did: <one line>
   - improved: <the weekly reflection file; playbook and rule changes are proposals>
   - proposed: <proposal filenames, or "none">
   ```
2. Rewrite `{{VAULT}}/persona/STATE.md` (same rules as monitor; update the `reflect:` line under `## Last Duty Runs`; ≤1,200 characters).
3. **Do not commit**: STATE.md and the journal are ignored by the vault's `.gitignore`, and a duty never runs `git commit`. The reflection stays in the working tree for {{ADDRESS_AS}} to review and commit; the proposals wait in `persona/proposals/`.
