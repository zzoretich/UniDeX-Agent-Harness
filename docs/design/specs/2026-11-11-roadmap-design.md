# Public roadmap: `roadmap/roadmap.md` and its GitHub Pages page

Status: approved 2026-11-11 · repo docs and CI only (no runtime, plugin or app change)

## Problem

UniDeX has no roadmap. The owner wants one file, `roadmap/roadmap.md`, that they edit by hand with new features,
functions and improvements, and that two readers use:

- **People** visit a visual roadmap on GitHub Pages to see what's coming. The page is built from the file, so it never
  drifts from it.
- **The owner's build agent** (a Hermes agent) reads the file as specs. It picks an item, writes its own proposal
  (which the owner approves or rejects), then builds it as PRs the owner approves. Some items are bare ideas, some are
  an idea plus a plan; the agent must be able to build from either without coming back to ask.

Goals: adding an item takes a few plain sentences; the page is always the file; a bad edit fails a PR, not the live
page. Anti-goals: an item format that feels like filling in a form; personal information in public; a page that shows
a status the file doesn't. Non-goals: the agent's proposal workflow (it keeps its own), comments or voting.

## Decisions

"Owner" marks what the owner decided in the interview; every other row is a design call the owner can overturn.

| # | Decision | Rejected |
|---|---|---|
| D1 | **One source, `roadmap/roadmap.md`, edited by hand** (owner). The page is generated from it on every merge. | GitHub Projects or issues as the source: not one file an agent reads as specs, and a second place to keep in step. |
| D2 | **Item format** (owner approved the shape): a heading `### UDX-NNN · Title`, one metadata line `status: … · type: … · area: …` (plus `release: vX.Y.Z` when shipped), then the owner's prose. The first paragraph leads the item's panel; cards don't show it (the approved mockup). Optional `####` sections follow: `Must`, `Not`, `Done when`, or any other (`Plan`, `Notes`), shown in order. Separators are lenient: `·`, `-`, `–`, `—` or `\|`, so nothing needs a special key. | YAML or JSON per item: form-filling (anti-goal). One `##` section per status: moving an item means moving its block, with more merge conflicts. |
| D3 | **Statuses** (owner): `idea → planned → approved → building → shipped`, forward only. `planned` means the item has spec sections; the owner sets it. **Types** (owner): `feature`, `function`, `improvement`. **Area**: one free lowercase word (`app`, `cli`, `plugins`…); the page's area filter lists the areas present. | A `proposed` status: proposals are the agent's own business (owner). A fixed area list: new areas would need a code change. |
| D4 | **Who moves the status** (owner): the owner writes and edits items; the agent changes the status line inside its own PRs: `approved` once its proposal is approved (or folded into its first PR), `building` in its first PR, `shipped` in its last. Every change reaches `main` through a PR the owner approves. | The owner updating status by hand: it lags, and the page then lies. |
| D5 | **Release stamp**: a `shipped` item without `release:` shows under "Next release"; `npm run version:bump <x.y.z>` writes `release: v<x.y.z>` onto those items, alongside the CHANGELOG roll. | The agent writing the version: it can't know which release will carry its PR. By hand: drifts. |
| D6 | **Layout B** (owner chose it from three mockups): lanes **Now** (`building`), **Next** (`approved`, then `planned`) and **Later** (`idea`), then **Recently shipped**, grouped by release, newest first, each linking its release notes. A card shows ID, title, exact status, type and area. Clicking it opens a side panel (owner approved): the full prose, a progress strip Idea→Shipped, the `####` sections, a link to the item (`…/#UDX-001`, which opens the panel on load) and a link to its heading in roadmap.md on GitHub. Filters by type and area. Light and dark follow the system, with an Auto/Light/Dark toggle. The header says "updated from roadmap.md on <date>". | A status board with one column per status (A): six columns, harder to scan for visitors. A vertical timeline (C). |
| D7 | **Built at deploy time by `tools/roadmap.js`**, zero-dependency CommonJS with `node:test` tests, like `tools/changelog.js`: `check` validates, `build --out <dir>` writes one static folder. The page's template, CSS and script live in `roadmap/site/`. The built folder is never committed. | Parsing the Markdown in the visitor's browser: needs a Markdown library, and the PR check and the page could disagree. Jekyll or a site framework: new dependencies for one page. Committing the built HTML: drift and noisy diffs. |
| D8 | **Its own workflow, `.github/workflows/roadmap.yml`**: runs on a push to `main` that touches `roadmap/**`, `tools/roadmap.js` or itself, and on manual dispatch. A read-only `build` job runs `check` then `build` and uploads the Pages artifact; a `deploy` job alone holds `pages: write` and `id-token: write`, deploys that artifact and runs nothing from the repo (release.yml's split). Actions pinned to commit SHAs (Dependabot already updates them). Concurrency group `pages`, never cancelled. | A job in `ci.yml`: widens the read-only workflow the repo keeps on purpose. |
| D9 | **Every PR checks the file**: `node tools/roadmap.js check` in ci.yml's lint job. It fails on a duplicate or malformed ID, a missing or unknown status or type, a missing title, `release:` on an item that isn't shipped, a malformed release, or a `planned` item with no `####` section, and names the line. It checks one snapshot, so "forward only" and "never reuse an ID" are kept by convention and the owner's PR review: an item isn't deleted once public, and the next ID is the highest ever used + 1 (the guide shows `git log -S` to check). | Checking only at deploy: a bad edit would merge and then stop the page updating. `check` diffing the PR against `main`: a second interface and a base-branch fetch to enforce what review already catches. A retired-ID list in the file: changes the approved format. |
| D10 | **Item text is escaped**: the build HTML-escapes everything and renders a small Markdown subset only (paragraphs, lists, bold, italic, inline code, `http(s)` links). The page loads no external script, font or tracker. The agent writes to this file too, and the page is public. | Full Markdown with raw HTML. |
| D11 | **Public and gated**: everything under `roadmap/` is public and the privacy gate scans it like every tracked file; `roadmap/README.md` says so. Public files name the agent generically ("an agent"), so the guide works for anyone's agent. | — |
| D12 | **Address**: GitHub's default, `https://zzoretich.github.io/UniDeX-Agent-Harness/`. The README links it (a line near the top and a row in "Docs & credits"). The owner switches Settings → Pages → Source to "GitHub Actions" once (a repo setting, not code). | A custom domain: later, if wanted. |
| D13 | **Seed** (owner): roadmap.md starts with one item, `UDX-001 · Choose your colour scheme`, `status: idea · type: feature · area: app`, no `####` sections, and this prose (the owner approved it): "Let users change UniDeX's colours by picking from a set of schemes: shades of blue, green, pink and more." | — |

## What already exists (main at 00546f9)

- No roadmap anywhere in the repo. Pages is not enabled (`GET /repos/…/pages` → 404). The repo is public.
- `ci.yml` and `privacy.yml` run with `permissions: contents: read` ("a job that ever needs more scopes its own").
  `release.yml` splits a read-only build from a publish job that holds the write token and runs nothing from the repo.
- `tools/changelog.js`: the precedent for a zero-dependency Markdown parser with a `check` verb in ci.yml's lint job;
  `tools/*.test.js` run under `npm test` and CI. `tools/bump-version.js` already rolls CHANGELOG.md during a bump.
- `eslint.config.js` lints every `.js` with Node globals; browser code needs its own block (precedent:
  `app/scripts/smoke-packaged.mjs`). The privacy gate scans every tracked file (`git ls-files`).
- Brand: the banner's palette (`#0d1117`, `#161b22`, `#30363d`, `#e6edf3`, `#8b949e`) and the `UDX` mark
  (`hud/src/brand.ts`). Dependabot updates the pinned GitHub Actions weekly.

## Design

New files:
- `roadmap/roadmap.md`: a short public intro, a one-line pointer to the guide, then the items (D2, D13).
- `roadmap/README.md`: the guide for people and agents: the item format with the UDX-001 example and a made-up
  planned example (clearly a sample, not a decision about UDX-001), the statuses and who moves them (D3, D4), the rule that an ID is never reused (a removed item's ID stays
  retired), that the file is public (D11), and how to preview (`node tools/roadmap.js build --out /tmp/rm`).
- `roadmap/site/index.html`, `style.css`, `app.js`: the page template and its behaviour (D6).
- `tools/roadmap.js` + `tools/roadmap.test.js` (D7, D9, D10); `.github/workflows/roadmap.yml` (D8).

Changed: `ci.yml` (one lint step, D9); `eslint.config.js` (browser globals for `roadmap/site/**`); `tools/bump-version.js`
+ its test (D5); `README.md` (D12); `CHANGELOG.md` `### Added`: one line with `<!-- no-tour: a page on GitHub, not in
the app -->`.

Parsing: an item runs from its `### UDX-` heading to the next `##`/`###` heading or the end. Text before the first item
is the intro. `parse(text)` returns `{ intro, items, errors }`; `check` prints errors with line numbers (exit 1);
`build` refuses to write when there are errors. The heading's GitHub anchor is computed the way GitHub slugs headings
(lowercase, punctuation dropped, spaces to hyphens: `udx-001--choose-your-colour-scheme`), and tested. The "updated"
date is the last commit that touched `roadmap/roadmap.md` (the build job checks out full history). The repo URL comes
from `GITHUB_REPOSITORY`, with the public repo as the fallback for local previews.

Page behaviour: lanes stack on a phone and the panel becomes a full-screen sheet; cards are buttons; Esc closes the
panel; an empty lane says so. Status colours: idea grey, planned blue, approved amber, building purple, shipped green.

Tests: a full parse of the seed and of a planned item; each separator form; every check error; `<script>` in prose
rendered as text and a `javascript:` link dropped; lanes assigned by status; the slug; the bump stamping only shipped
items without a release.

Left to the builder: the light palette, exact spacing and type, how the intro shows on the page, and ordering inside a
lane (ID order is the default).

## Host parity

1. No host detection. 2. No hooks. 3. No session data read. 4. No model call. 5. No config key. 6. The HUD and app
don't change. 7. Known gaps unchanged. The roadmap is repo documentation plus a Pages workflow; nothing installs or
runs on a user's machine.

| Mode | How the user invokes it | What runs | What they see if it can't |
|---|---|---|---|
| Claude Code only | opens the roadmap page or roadmap.md | nothing on their machine | — |
| Codex only (plugin · direct) | same | nothing on their machine | — |
| Both | same | nothing on their machine | — |

## Out of scope

The agent's proposal workflow. A Roadmap link inside the UniDeX app (a follow-up; it needs a release). A custom
domain. Comments, voting, RSS or a JSON feed. Importing ideas from anywhere else; the owner adds items themselves.
