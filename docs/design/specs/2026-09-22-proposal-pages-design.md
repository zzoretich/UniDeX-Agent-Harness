# Proposal pages — design

Date: 2026-09-22 · Branch: `feat/proposal-pages` · Verified against `c7c15f0`

## 1. Problem

The Proposals tab shows what the Chief of Staff files in `persona/proposals/`, but proposals reach the owner in
other ways too, and none of them share a shape:

- **Proposals written in a session live anywhere.** A plan Claude writes for the owner to decide on ends up as a
  loose HTML file or a chat answer. It never reaches the tab, the ledger or the review, so it is never decided.
- **A proposal is only Markdown.** The tab renders What / Why / Risk inside Obsidian; outside it (a browser, a
  phone, a shared link) there is nothing readable, and no link between the file and a page.
- **The review cannot decide an owner-filed proposal.** `recheck.js` drops its input path unless `--root` is
  passed (`:135`), so the flag-closer's step 2 prints a usage error; and every decision `git rm`s the proposal
  file, which fails for the untracked files that duties (and now `/propose`) leave behind.

## 2. Decisions

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| D1 | The Markdown file `persona/proposals/<date>-<slug>.md` stays the one source. The HTML page is derived from it and never edited by hand. | HTML as the source; both written by hand. | `collect.js`, `recheck.js`, `backlog.js`, the ledger and the tab all read the Markdown. A derived page cannot drift. |
| D2 | One renderer, `brain/scripts/persona/proposal-html.js`, writes `<vault>/brain/_index/proposals/<date>-<slug>.html`. Pages stay after the review deletes the Markdown, so Backlog and History rows can still open them. | Next to the Markdown in `persona/proposals/`; render in the HUD. | `brain/_index/*` is the gitignored cache folder written only by scripts. Beside the Markdown the page is orphaned by every decision and dirties git; a TypeScript renderer would leave Codex and CLI users without pages. |
| D3 | The filer renders at once: the reflect duties and `/propose` run the renderer right after writing the file. `scan-vault.js` renders any pending proposal whose page is missing or older than its Markdown, and the flag-closer renders before it collects. | Tick only; filer only. | Rendering in the filer's own run keeps the tick's `proposals` signature (`tick.js:153`, newest mtime) to one change per filing. The scan catches hand-written and legacy files; the review guarantees a page before a decision deletes the source. |
| D4 | Every proposal has one format: frontmatter, `# <Title>`, the link line `**[Open the proposal in browser](file:///…/<date>-<slug>.html)**`, then What / Why / Risk / Premises. The renderer writes or repairs only the link line, atomically, and only when it differs. Without a title the link goes first in the body and the page falls back to the slug. | "Open … in Chrome"; the link only in the HUD. | The product cannot assume a browser; the OS opens its default. A link stored in the file also works when the Markdown is opened in Obsidian, on GitHub or in an editor. |
| D5 | The page is self-contained with no scripts (CSP `default-src 'none'; style-src 'unsafe-inline'; img-src data:`) and uses the review digest's light/dark tokens. The header shows kind, surface, filed date, title, target, the decision the review will ask for and the recheck recipe, with **Open in Obsidian** and **Markdown source** links. Then What, Why, Risk, and Premises as a table with VERIFIED / ASSUMED pills. | A Markdown package; passing raw HTML through. | Zero new runtime dependencies. Duties read untrusted text (commit messages, journal), so every text node is escaped and only `http(s)`, `file`, `obsidian` and relative links become anchors. |
| D6 | A new prompt-only command, `/propose <idea>`, files a proposal in the D4 format from any Claude Code or Codex session: it picks kind and surface, writes a read-only recheck, ledgers `filed --by user`, renders and replies with the link. `vault-template/AGENTICOS.md` lists it and adds one convention: a proposal for the owner to decide goes through `/propose`, not a loose file. | The convention line only; an MCP write tool. | A command is a deterministic path that also writes the ledger line. A second MCP write tool is a trust step the owner has not taken (tabs spec D2). |
| D7 | The Proposals tab lists `brain/_index/proposals/` on refresh. A pending row's detail opens with **Open the proposal in browser** (or "the page appears after the next scan"); Backlog and History rows get the same link when a page exists for their slug. It opens through `shell.openPath`. The tab stays read-only. | Render the page inside Obsidian; buttons that decide. | `SpacesTab.ts:367` already opens files in the OS default app this way. Deciding stays with the flag-closer (tabs spec D6). |
| D8 | The review's two blockers are fixed in the same PR, as separate `fix:` commits. `recheck.js` keeps its first positional argument when `--root` is absent. The flag-closer deletes an untracked proposal with `rm` and names only tracked paths in `git rm` and the commit pathspec. | A separate PR; `/propose` commits its own file. | Without them no owner-filed proposal can be accepted. Duties never commit, so one rule has to cover both kinds of file. |

## 3. What already exists (at `c7c15f0`)

- `hud/src/data/proposals.ts:9` — `PROPOSALS_DIR`, `parseProposal()` mirroring `collect.js`;
  `proposals.test.ts:25` runs both parsers on one fixture vault and compares field by field.
- `hud/src/views/ProposalsTab.ts:172` — the pending detail: meta, What / Why / Risk through
  `MarkdownRenderer`, premises, **Open file**. `:52` watches `persona/` paths; `:81` `refresh()`.
- `hud/src/views/SpacesTab.ts:367` — `require("electron").shell.openPath(abs)`.
- `brain/scripts/scan-vault.js:418` — `main()` runs each cache builder in its own try/catch and pushes to `report.wrote`.
- `brain/scripts/persona/tick.js:153` — the signature takes the newest mtime under `persona/proposals`.
- `brain/scripts/persona/recheck.js:135` — `i !== rootIx + 1` is `i !== 0` when `--root` is absent.
- `plugin/skills/persona-flag-closer/scripts/render-digest.js:7` — `esc()` and the light/dark token block.
- `plugin/skills/persona-flag-closer/SKILL.md:32-36` — every decision runs `git rm -q persona/proposals/<file>`.
- `vault-template/_gitignore:2` — `brain/_index/*` is untracked.
- `vault-template/persona/proposals/README.md` — the format; `interview.js:159` seeds it and keeps an existing copy.
- `plugin/commands/todo.md` — the prompt-only command pattern; `cli/plugin-commands.test.js:11` expects 16 commands.

## 4. Design

### 4.1 `brain/scripts/lib/markdown-html.js` (pure)

`toHtml(md)` covers ATX headings, paragraphs, `-`/`*`/`1.` lists with one level of nesting, `**bold**`, `*em*`,
`` `code` ``, fenced blocks (a `diff` fence colours `+` and `-` lines), GFM tables, `>` quotes, `---` rules and
`[text](url)` links. Every text node goes through `esc()`. A link whose scheme is not `http`, `https`, `file`
or `obsidian` (or a relative path) renders as its text. Raw HTML in the source is shown escaped.

### 4.2 `brain/scripts/persona/proposal-html.js`

- `pagePath(root, name)` → `<root>/brain/_index/proposals/<name without .md>.html`.
- `linkLine(url)`, `withLinkLine(text, url)` (pure): insert or replace the one line matching
  `^\*\*\[Open the proposal in browser\]\(`, after the `# ` title when present, else first in the body.
- `renderPage({ name, text, root, now })` (pure) → the HTML string (D5). Premises come from the same table rule
  `collect.js` uses; the intro between the title and `## What`, minus the link line, renders under the title.
- `render({ root, files })`: for each pending file, it writes the page when the page is missing, older than
  the Markdown, or from an older renderer version (`<meta name="aos-renderer" content="1">`). It fixes the link
  line with a temp file and rename, only when the line differs. Output: `{ schema: 1, rendered, linked, skipped, errors }`.
- CLI `node proposal-html.js [--root <vault>] [<file.md>…]` (no files = every pending proposal) prints one
  JSON line; exit 0, 2 on a usage error. A vault without `persona/proposals/` is a no-op.

### 4.3 Wiring

- `scan-vault.js main()`: one try/catch block calling `render({ root: VAULT })`, pushing `brain/_index/proposals/`.
- Duties `reflect.md` and `reflect-daily.md`: after the `ledger.js append filed` line, run the renderer on the file.
- `persona-flag-closer/SKILL.md` step 1: run the renderer before `collect.js`. Steps 6a–6e: the untracked rule (D8).
- `vault-template/persona/proposals/README.md`: the `# <Title>` line and the link line in the format block.
- `plugin/commands/propose.md` (`allowed-tools: Bash, Read, Write`): the D6 steps; creates `persona/proposals/`
  when missing; the reply is the title plus the page link.

### 4.4 HUD

`proposals.ts` gains `PAGES_DIR` and `pageFor(name)` / `pageForSlug(names, slug)` (pure, tested). `ProposalsTab`
reads the page list in `refresh()`, watches `brain/_index/proposals/` too, and renders the links per D7 through
a small `openExternal(abs)` helper built on `vaultRoot()`.

## 5. Testing

- `brain/scripts/test/markdown-html.test.js`: each block type; escaping of `<script>` and attribute quotes;
  `javascript:` and `data:` links render as text; a table inside a list.
- `brain/scripts/test/proposal-html.test.js`: link-line insert, replace and no-op (the file's mtime stays put);
  page for each fixture kind; missing title; stale page re-rendered, fresh one skipped; the CLI with and without `--root`.
- `brain/scripts/test/persona-recheck.test.js`: the positional argument survives without `--root`.
- `hud/src/data/proposals.test.ts`: `pageFor` / `pageForSlug`.
- Counts: 17 commands (`cli/plugin-commands.test.js`), generated Codex skills 20 → 21 (`cli/codex-host.test.js`,
  `cli/aos.test.js`), README and `docs/install.md` lines. `npm run gate`, `npm test`, the HUD build, the rehearsal.
- `docs/plugin-smoke.md`: open a pending page, a backlog page and a history page from the tab.

## 6. Out of scope

- Pages for proposals decided before this change (their Markdown is gone). Linking pages from the review digest.
- Publishing pages anywhere; editing or deciding from a page; a Codex-specific review flow.
- Updating an existing vault's `AGENTICOS.md` and proposals README (upgrades keep both; Workbench Proposal 5).
