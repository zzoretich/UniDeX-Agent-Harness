# Private privacy terms — design

Date: 2026-09-23 · Branch: `feat/private-terms` · Verified against `8875d2e` (v0.13.0) · Workbench 1.0 proposal P2 ·
Decisions approved by the owner 2026-09-23; history: rewrite and purge (§6)

## 1. Problem

The privacy gate exists to keep the owner's personal details out of this public repository, and it does that by
committing the details it protects. `tools/privacy-terms.json` holds 22 terms; 17 of them describe the owner (names,
account identifiers, workplace and project names, the tools they use). Three more tracked files leak the same terms:

- `tools/export-scrubs.js`, the vault→repo scrub table. Its `from` strings are the private identifiers it rewrites,
  so it names five terms. It is exempt from the gate with `"*"`.
- `tools/privacy-gate.test.js` and `tools/export-from-vault.test.js` build real terms by string concatenation to pass
  the gate. Anyone reading the test can join the halves.

The gate also never sees commit messages or PR text on GitHub: the owner's `commit-msg` hook is local, and a squash
merge writes the PR's commit messages (`squash_merge_commit_message: COMMIT_MESSAGES`) and title to `main`.

## 2. Decisions

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| D1 | **Two tiers.** `tools/privacy-terms.json` keeps only generic terms that say nothing about the owner (the macOS home-directory prefix, credential prefixes). Private terms live in `tools/privacy-terms.local.txt` (gitignored; one term per line, blank lines and `#` comments ignored) and, in CI, in the `AOS_PRIVACY_TERMS` Actions secret in the same format: `gh secret set AOS_PRIVACY_TERMS < tools/privacy-terms.local.txt`. | Salted hashes of tokens; a private file outside the checkout. | A first name or a company is recovered from a hash with a small dictionary, and hashing loses substring matches such as a path fragment. A file outside the checkout is per-machine and invisible, and every consumer would need a second setting. One format for file and secret makes the sync one command. |
| D2 | **One loader**, `tools/privacy-terms.js`: `loadTerms({ root, env })` → `{ public, private }`. Private = the file (`AOS_PRIVACY_TERMS_FILE` overrides its path) ∪ `AOS_PRIVACY_TERMS`. The gate, the export tool and the owner's local hooks all read terms through it. | Each consumer parses its own file. | Four readers of the same list drifted once already (the tests hard-code terms). |
| D3 | **Gate behaviour.** `--require-private` exits 2 when no private term loaded: CI on this repo, the export tool, the owner's pre-commit. Without it, a missing private list prints one stderr notice and scans the public terms (fork PRs, contributors). A tracked `tools/*.local.*` file is a violation. When `CI` is set, a private-term hit prints `file:line: [private term]` with no line text, and under GitHub Actions every private term is first registered with `::add-mask::`. | Print hits the same everywhere; never print them. | Public CI logs would republish the term the gate just caught. Locally the owner needs the text to find the hit. |
| D4 | **`--stdin <label>`** scans stdin as one virtual file. CI pipes `git log --format=%B <range>` and the PR title and body through it. | A separate message scanner. | Same terms, exceptions and redaction; about 20 lines. |
| D5 | **The scrub table leaves the repo.** It moves to `tools/export-scrubs.local.js` (gitignored); `tools/export-scrubs.example.js` documents the shape with neutral values. `export-from-vault.js` takes `--scrubs <file>` (default the local file), exits 2 with a pointer to the example when it is missing, and passes the table into `plan()` / `applyScrubs()`. The export's own gate run uses `requirePrivate`. | Keep it public and turn every `from` into a pattern. | The `from` strings are the private identifiers by definition, and the table only serves the owner's vault. |
| D6 | **Tests use synthetic terms only**, injected through arguments, `AOS_PRIVACY_TERMS` and `AOS_PRIVACY_TERMS_FILE`; the export tests carry their own fixture scrub table. No concatenated real terms remain. | Keep the concatenations. | They are the leak. |
| D7 | **A separate `privacy.yml` workflow**: ubuntu, Node 20, `permissions: contents: read`, `fetch-depth: 0`, on push to `main` and on `pull_request` including `edited`, so an edited PR body is rescanned. Steps: gate with the secret and `--require-private` (fork PRs get no secrets and run public-only with a notice), commit messages over the pushed or PR range, PR title and body, gitleaks over the same range. `ci.yml` drops its `npm run gate` step. | Add the steps to `ci.yml`. | An `edited` trigger on `ci.yml` would rerun the six-leg test matrix for every PR-text edit, and the matrix ran the gate four times without the private list. |
| D8 | **gitleaks 8.30.1** as the release binary, fetched in the workflow and checked against its sha256 (`linux_x64`: `551f6fc8…70eb`), always `--redact`. `.gitleaks.toml` extends the default rules with `personal-email` (noreply and example addresses allowed), `claude-session-url` and `home-path`. | `gitleaks/gitleaks-action`. | A tag-pinned third-party action with a licence check for organisations; the 1.0 review (S8) asks for pinned, verified downloads. Baseline: the full history (251 commits) has 0 findings under the default and the custom rules, and a planted-leak probe trips all three custom rules (checked 2026-09-23). |
| D9 | **History is a separate, owner-approved step** after this merges (§6). | Rewrite inside this PR. | A rewrite force-pushes `main` and every tag; it must follow the change that stops new leaks, not precede it. |
| D10 | **Owner-local tooling follows the loader**: the untracked `.git/hooks/commit-msg` reads terms through `tools/privacy-terms.js`, and `pre-commit` runs `npm run gate -- --require-private`. | Leave them on the JSON file. | They would silently check only the public terms. |

An exception in `tools/privacy-exceptions.json` may name a private term only where that term already appears in the
excepted public file, so the exception reveals nothing the file does not. The `tools/export-scrubs.js` entry goes.

## 3. What already exists (at `8875d2e`)

- `tools/privacy-gate.js`: `scan({ root, terms, exceptions, files })`, `listFiles()` (tracked + untracked-not-ignored),
  exit 0/1/2. `tools/export-from-vault.js:15` requires `./export-scrubs.js` at load; `:100` `runGate()` reads the JSON.
- `.github/workflows/ci.yml`: `test` matrix (ubuntu/macos × Node 20/22) runs `npm run gate`; `first-run` rehearsals.
- `main` has no branch protection and no rulesets, so a new workflow changes no required check.
- Nothing outside `tools/` reads the term list; nothing copies `tools/` into the vault or a plugin.

## 4. Design

**Loader** (`tools/privacy-terms.js`, CommonJS, no dependencies). `parseList(text)` trims lines and drops blanks and
`#` comments. `loadTerms()` returns deduplicated `public` (JSON array) and `private` (file ∪ env, case-insensitive).
The CLI `node tools/privacy-terms.js --check-message <file>` exits 1 naming the private hits, for the commit-msg hook.

**Gate.** `main()` loads through the loader and scans `public ∪ private`; each violation carries `private: true|false`.
New flags: `--require-private`, `--stdin <label>`. Output is unchanged for public terms and outside CI.

**Export.** `plan({ source, dest, force, table })` and `applyScrubs(destRel, text, report, table)`; `walk()` takes
`exclude`. `main()` loads `--scrubs` or the local file, then `runGate(dest)` with private terms required.

**CI** (`privacy.yml`), range per event: push → `before..sha` when `before` is a commit in the clone, otherwise `sha^!`;
pull_request → `base.sha..head.sha`. PR title and body reach the step through `env:`, never inline `${{ }}` in `run:`.

## 5. Host parity

Repository tooling only: no change to the runtime, `plugin/`, `codex-plugin/`, hooks, MCP tools or config keys.

| Mode | How the user invokes it | What runs | What they see if it can't |
|---|---|---|---|
| Claude Code only | not user-facing | nothing new | — |
| Codex only (plugin · direct) | not user-facing | nothing new | — |
| Both | not user-facing | nothing new | — |

## 6. History (owner's choice: rewrite and purge)

Every private term is in the initial commit's `tools/privacy-terms.json`, and five are in every version of
`tools/export-scrubs.js`. Removing the file from HEAD does not remove it from history, the 18 release tags, their
source archives, or the 34 `refs/pull/*` heads GitHub keeps. The purge, if chosen: `git filter-repo` dropping
`tools/export-scrubs.js` and replacing the private terms and the test concatenations in every blob; force-push `main`
and the tags; then ask GitHub Support to drop cached views and the pull-request refs. Existing clones diverge. The
alternative purge is deleting and recreating the repository, which loses PR history and the star.

## 7. Out of scope

gitleaks in the local pre-commit hook · secret scrubbing of vault content (review S7) · pattern rules in the gate
itself · the other 1.0 proposals.
