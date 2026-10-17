# Files as a Finder: build plan

Spec: `docs/superpowers/specs/2026-10-17-files-finder-design.md` (approved 2026-10-17; D1–D26; A1 on, A2–A4 as proposed), built on `feat/files-finder` in the worktree `files-finder`. Three PRs, each shippable alone (D5, §6): read and look, act, find; then 2.1.0. Each PR runs the skill's verify (§5) and publish check (§6) before it opens. Code comments cite `files-finder D<n>`.

## File structure

| File | PR | New / changed | What |
|---|---|---|---|
| `obsidian-plugin/src/data/filesModel.ts` (+ test) | 1, 2, 3 | new | Kinds and their labels; the kind tab per path (D3); sort and groups (D7, D8); selection with cursor and anchor (D4); back/forward history; the key map; type-ahead; size and date labels. PR 2: the undo stack (D16). PR 3: smart folders (D20) |
| `obsidian-plugin/src/data/vaultIndex.ts` (+ test) | 1, 2 | new | `parseNote` (frontmatter tags, wiki/embed/Markdown links, the first lines' lengths), `resolveLink`, `buildVaultIndex` (yields every 40 files; the shared mtime cache), `linksOf` / `backlinksOf`. PR 2: `rewritePlan` (D17) |
| `obsidian-plugin/src/data/vaultFiles.ts` (+ test) | 1, 2 | changed | exports `readCached` (the cache `searchVault` uses) and `IMAGE_EXTENSIONS`; PR 2: `newFolderPath`, `duplicatePath` |
| `obsidian-plugin/src/settingsDefaults.ts` (+ test) | 1 | changed | `files: FilesChoice` (view, sort, direction, preview, favorites, recents), D21 |
| `obsidian-plugin/src/views/files/FilesTab.ts` | 1, 2, 3 | new (replaces `views/FilesTab.ts`) | the shell (D6): toolbar, the view host, path and status bar, vault events, focus and keys (D23), Open (D12), the search results kept from today |
| `obsidian-plugin/src/views/files/{IconView,ListView,ColumnView}.ts` | 1, 2 | new | the three views (D7–D9); PR 2: rename in place, and drag sources and targets |
| `obsidian-plugin/src/views/files/{Sidebar,Preview,QuickLook,Menu,art}.ts` | 1, 2, 3 | new | sidebar (D20), preview (D10), Quick Look (D11), right-click menu (D13), folder and page art (D3, D7) |
| `obsidian-plugin/src/views/files/chores.ts` | 1, 2 | new | today's new-note, rename, move and Trash forms moved here; PR 2: inline rename, new folder, duplicate, move with links (D14–D17) |
| `obsidian-plugin/src/views/files/drag.ts` | 2 | new | drag and drop (D15) |
| `obsidian-plugin/src/views/WorkbenchView.ts`, `main.ts` | 1 | changed | import the new FilesTab |
| `obsidian-plugin/styles.css` | 1, 2, 3 | changed | `.aos-fx-*` on `--udx-*` tokens; the `.aos-fl-*` rules removed |
| `obsidian-plugin/src/tour/steps.json` | 1, 2, 3 | changed | the Files chapter's anchors moved, new steps `since` 2.1.0 (D26) |
| `app/src/shared/surfaces.ts`, `app/tests/unit/write-policy.test.ts` | 2 | changed | the `files` source text and its live-check comment (D25) |
| `app/tests/e2e/{files,files-writes,variants,tour}.spec.ts` | 1, 2, 3 | changed | the new DOM and behaviours; Files on a Codex-only vault |
| `app/tests/screens/readme.screens.ts`, `docs/assets/screens/files.png`, `README.md` | 1 | changed | the Icons view on `workspaces/harbor-map`; the alt text |
| `docs/app-smoke.md`, `app/tests/e2e/COVERAGE.md` | 1, 2, 3 | changed | the Files section rewritten (F1–F16) |
| `CHANGELOG.md` | 1, 2, 3 | changed | `[Unreleased]` lines with tour markers |

## PR 1: read and look

- [ ] `filesModel.ts` and its tests:
  - `kindOf` and `KIND_LABEL`;
  - `tintOf(path, yearRoots)`;
  - `sortEntries` by name, modified, size or kind, with folders first;
  - `groupByKind`;
  - selection: `selectOnly`, `toggle`, `extendTo`, `selectAll`, `moveCursor`, and `keep` after a redraw;
  - history: `go`, `back`, `forward`;
  - `keyAction`, `typeAhead`, `sizeLabel`, `dateLabel`. `dateLabel` uses local time; the tests pin a zone-free clock.
- [ ] `vaultIndex.ts` and its tests:
  - `parseNote`: inline and block `tags:` through `parseFrontmatter`; `[[a]]`, `[[a|b]]`, `[[a#h]]`, `![[a]]` and `[t](rel.md)`, but not `http(s):` links or links in code fences;
  - `resolveLink`: the exact path, the path plus `.md`, then the shortest basename match;
  - `buildVaultIndex` with cancellation;
  - backlinks.
- [ ] `vaultFiles.ts`: export `readCached` and `IMAGE_EXTENSIONS`; `searchVault` uses `readCached`.
- [ ] `settingsDefaults.ts`: `files` defaults and the merge of a stored value (tested).
- [ ] `views/files/*`:
  - the shell, the three views and the sidebar (default favorites);
  - the preview (Columns always, a ⇧⌘P pane elsewhere);
  - Quick Look;
  - the right-click menu, its write items wired to `chores.ts` (today's forms);
  - + New ▾ (note);
  - Reveal in Finder and Open with default app;
  - the Workspace chip;
  - keys (D23).
- [ ] `styles.css` `.aos-fx-*`, both themes, and `check:hex` clean. Under 900 px the sidebar folds.
- [ ] Tour: re-anchor `count`, `new-note`, `open`, `search`, `scope` and `tree`. New steps `views` and `quicklook` (`since` 2.1.0).
- [ ] e2e `files.spec.ts`:
  - top level and kinds;
  - double-click to enter and open;
  - the three views and their memory;
  - the preview and Quick Look;
  - keys;
  - search;
  - Open file… and Search vault…;
  - runtime folders.

  `files-writes.spec.ts`: the same writes through the menu and + New. `variants.spec.ts`: Files on a Codex-only vault.
- [ ] Docs: `app-smoke.md` Files rewritten for PR 1's behaviour, COVERAGE rows and totals, `CHANGELOG.md`, the README screenshot (`cd app && npm run screens`) and its alt text.
- [ ] Verify (§5) with the app checks; publish check; PR.

## PR 2: act

- [ ] Rename in place in each view (D14), with ↩ and Esc. New folder (⌥⌘N). Duplicate (⌘D, `adapter.copy` + `duplicatePath`).
- [ ] Drag (D15): views, favorites and path-bar targets; a multi-file preflight; no-drop in the runtime's folders.
- [ ] The undo stack (D16) with a toast; Trash's toast points to the Trash in Finder.
- [ ] Link updates (D17): `rewritePlan` tests (aliases, headings, embeds, Markdown links, links inside protected folders listed as not updated) and *Update N links* in the rename field and on drop.
- [ ] `surfaces.ts` `files.source` text; `write-policy.test.ts`. Live check of every write on a copy of a real vault, recorded in the surface comment (D25).
- [ ] e2e under `AOS_APP_WRITE=files`; tour step `drag`; smoke items and COVERAGE; CHANGELOG.

## PR 3: find

- [ ] Thumbnails (D19): lazy, ≤ 4 MB, an LRU of 200, one per frame; tested with a large PNG in the fixture and an oversize one.
- [ ] Smart folders (Recents, Changed today, Images), Tags, editing Favorites (drag in, Remove), all through `saveData`.
- [ ] The search scope bar (D22): Vault or this folder, Names or Contents.
- [ ] e2e, tour step `favorites`, smoke, COVERAGE, CHANGELOG; then `whatsnew.json` 2.1.0 and the release when the user asks.
