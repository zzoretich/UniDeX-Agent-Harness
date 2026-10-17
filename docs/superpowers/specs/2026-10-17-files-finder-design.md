# UniDeX Files: a Finder for the vault — design

**Date:** 2026-10-17
**Status:** approved 2026-10-17 as written (A1 on, A2–A4 as proposed), on `feat/files-finder`. *(user)* rows are the user's picks from the option canvas (private); the rest are approved technical decisions. Amended before the first commit: the view keys are ⌃⌘1–3, because ⌘1–⌘9 switch tabs (§3).
**Base:** `main` at `a8a31f4` (2.0.0). The HUD (`obsidian-plugin/src`), its styles, tour and tests; the app's surface text (`app/src/shared/surfaces.ts`) and e2e. No runtime, plugin or `codex-plugin/` change.
**Scope:** the Files tab (rail id `files`, `obsidian-plugin/src/views/FilesTab.ts`) becomes a Finder window onto the vault. Code comments cite `files-finder D<n>`.

---

## 1. Problem

At `a8a31f4`:

1. **One view, no folders to look at.** Files is a single monospace tree (`styles.css:2205`); folders are a twisty and a name (`FilesTab.ts:122`). No icons, sizes, dates or kinds, and nothing to sort by.
2. **No selection.** A click opens the note at once (`FilesTab.ts:150`), so there is nothing to Quick Look, preview, select several of, or drag. The keyboard can only Tab through rows.
3. **Chores hide in hover glyphs and drawers.** ✎ → ✕ appear on hover (`:155`, `styles.css:2212`); rename and move open a drawer form (`:226`); there is no new folder, duplicate, undo or drag.
4. **Rename breaks links.** `vault.rename` (`:311`) moves the file and leaves every `[[link]]` to it pointing at the old name.
5. **Nothing but text opens.** Non-text files are inert rows (`:136-150`): an image can't be seen, and nothing opens in its own app or reveals in Finder.

## 2. Decisions

| # | Decision | Rejected |
|---|---|---|
| D1 | *(user)* **Scope:** Files is redesigned in place as a Finder window onto the vault; same rail slot, id and label. | A new tab. Merging it with Spaces' Files pane (which stays as it is). |
| D2 | *(user)* **Icons is the default view.** A switcher offers Icons · List · Columns (⌃⌘1 ⌃⌘2 ⌃⌘3); the choice is one remembered setting. | Columns as the default (the canvas's recommendation). List as the default. A view remembered per folder. |
| D3 | *(user)* **Graphite + a kind tab.** Folders are UniDeX greys; a tab marks the four top folders and is inherited by the folders under them: `brain` gate, `workspaces` info, `persona` ok, the daily-note year folders warn. Selection is the inverse fill. | Graphite only (recommended). macOS blue. |
| D4 | *(user)* **Finder's keys:** click selects (⌘/⇧-click add), double-click or ⌘↓ opens, ↩ renames, Space is Quick Look, arrows walk, ⌘↑ goes up, ⌘A selects all, ⌘⌫ trashes (it asks first), Esc clears. | Today's click-to-open. |
| D5 | *(user)* **Release 1 holds everything:** the views and preview, Quick Look and keys, right-click and rename, drag to move and undo, and thumbnails, smart folders and tags. It ships as three PRs (§6), released as 2.1.0. | A smaller first release. |
| D6 | **Shell:** a sidebar (Favorites, Smart folders, Tags); a toolbar (‹ ›, the folder's name and count, a *Workspace · Open in Spaces* chip on workspace folders, the switcher, Sort, + New ▾, ⋯, search); the view; a path bar with the status (items, selected, files in the vault). The sidebar folds into a toggle under 900 px. | Today's header, search row and drawers. |
| D7 | **Icons:** HUD-drawn folder art with item counts; note pages drawn with their first lines; thumbnails (D19); grouped by kind (Folders, Notes, Images, Other) by default; sort by name, date modified or size. | Lucide glyphs blown up. |
| D8 | **List:** Name · Date Modified · Size · Kind; a header click sorts; disclosure triangles expand in place (today's tree lives on here); a tag dot after the name. | A separate tree view. |
| D9 | **Columns:** Miller columns from the sidebar item that was picked; ← → move between levels; the last column is the preview (D10); it scrolls sideways when it is wider than the window. | Breadcrumb-only drilling. |
| D10 | **Preview:** always in Columns, and a pane (⇧⌘P) in Icons and List, off by default and remembered. It shows the first part of a note rendered (compat `MarkdownRenderer`), text as mono, or the image, then Kind, Size, Modified, Created, Tags, Links (out · in, D18) and Where, with Open, Quick Look and ⋯. | Spaces' `PreviewPane` as is: it is built around the workspace map. |
| D11 | **Quick Look:** Space opens an overlay: a note rendered, text as mono, an image fitted, any other kind as an icon, its info and *Open with default app*. ← → go through the view's order, ⌘↓ opens, Space or Esc closes. PDFs are not drawn inline (the CSP has `object-src 'none'`). | A note tab per look. |
| D12 | **Open:** a text file (`TEXT_EXTENSIONS`) opens in a note tab as today; any other file goes through `openPath`, which opens it in its default app or, for a package, shows it in Finder (the policy decides, `policy/shell.ts:38`); a folder is entered. | Text files only. |
| D13 | **Right-click menu** (a DOM popover like the HUD's other menus): Open, Open in new tab, Quick Look; Rename, Move to…, Duplicate (⌘D); New note here (⌘N), New folder (⌥⌘N); Copy path, Copy as [[link]], Reveal in Finder, Add to Favorites; Move to Trash. In the runtime's folders the write items are off and say why (`vaultFiles` protectedError). Several selected files take the items that fit. | The hover glyphs. An Obsidian `Menu` in compat. |
| D14 | **Rename in place:** the name becomes a field with the stem selected, and today's `renamePath` check runs live under it; ↩ commits, Esc keeps the name. New folder makes `untitled folder` (numbered when taken) and opens it for a rename. Move to… keeps its folder picker. | Drawer forms for rename. |
| D15 | **Drag to move:** from any view onto a folder, a favorite or a path-bar segment. Several selected files move together, and every `movePath` check passes before the first file moves. A runtime folder shows no-drop with the reason. | ⌥-drag to copy. Drops from or to macOS Finder. |
| D16 | **Undo:** ⌘Z undoes the tab's last move or rename (a stack of 20; an entry goes stale once its paths change), and a toast offers Undo. Trash keeps its confirm and has no undo, since `trashItem` can't put files back; its toast says to put them back from the Trash in Finder. | Undo through the Trash. |
| D17 | **Links follow a rename or move (A1):** when other notes link to the file, the rename field and the drop offer *Update N links*, on by default. `[[name]]`, `[[path]]`, `[[…\|alias]]` and `[text](path)` are rewritten through `vault.process`; notes in the runtime's folders are never written, and they are named as not updated. | Leaving links broken (today). Rewriting silently. |
| D18 | **A vault index in the HUD:** one background pass over Markdown builds each note's frontmatter tags and outgoing links (and from those the backlinks). It reuses `searchVault`'s mtime cache and yields every 40 files. It feeds the Links row, the Tags sidebar and D17. | A new runtime cache and collector. Emulating Obsidian's `metadataCache`. |
| D19 | **Thumbnails:** png, jpg, gif, webp and svg up to 4 MB, read with `adapter.readBinary` into a `data:` URL (the CSP's `img-src 'self' data:` already allows it). Read only when a tile comes into view, one per frame, cached by path and mtime (200 at most); anything else shows its kind icon. | A custom protocol or a CSP change. Reading every image up front: `readBinary` is synchronous per chunk. |
| D20 | **Sidebar:** Favorites default to the vault, Brain, Memory, Workspaces, Daily notes (the year folder from `dailyNote.layout`) and Persona; drag a folder in, right-click to remove. Smart folders: Recents (the last 50 opened from Files, ⌘O or Quick Look), Changed today (modified since local midnight), Images. Tags: the 12 most used frontmatter tags (D18); a tag lists its notes. | Recents from note-tab history: compat keeps none. |
| D21 | **What it remembers** (view, sort, preview, favorites, recents) lives in the plugin's data through `saveData`, following the `pulseSeenAt` and tour precedent: per machine, with no bridge call and no write surface. | `brain/config.json` keys for UI state. |
| D22 | **Search:** the toolbar field searches the current scope. A scope bar under it picks Vault or this folder, Names or Contents, and all text files. Contents keeps `searchVault`'s line hits grouped by file, and ↩ or Space works at the line; Names filters the current view. ⇧⌘F still lands here. | Kind and Modified filters, saved searches (later). |
| D23 | **Shortcuts.** Keys handled inside the view, which call `preventDefault` so the menu never sees them, work while focus is in Files and not in a field: arrows, ↩, Space, ⌘↑ ⌘↓, ⌘A, ⌘⌫, ⌘D, ⌘Z, ⇧⌘P, ⌃⌘1–3, ⌘N, ⌥⌘N, and ⌘F for search (Brain's tab-local ⌘F is the precedent). ⇧⌘N stays *New workspace*, and Code keeps its ⌘F. | ⇧⌘N for New folder (taken, `main.ts:142`). ⌘1–3 for views (they switch tabs). |
| D24 | **Code:** `views/files/` holds the shell, IconView, ListView, ColumnView, Preview, QuickLook, Menu, Sidebar and drag. The pure parts each get tests: `data/filesModel.ts` (selection, history, sort, groups, kinds, key map), `data/vaultIndex.ts` (tags, links, the rewrite plan), and `vaultFiles.ts` gains `duplicatePath` and `newFolderPath`. New classes are `.aos-fx-*` on `--udx-*` tokens, and the `.aos-fl-*` rules go. | Growing `FilesTab.ts` in place. |
| D25 | **The `files` surface keeps its rule** (`writes: **/*`, `except: PROTECTED`, `surfaces.ts:429`). Its `source` text names the new writes (a new folder, a duplicate, link updates). It stays `verified: true` only after each write has been checked live on a copy of a real vault, before PR 2 merges. | A new surface. |
| D26 | **Tour and What's new:** the Files chapter's anchors move to the new controls, with new steps for the switcher, Quick Look, drag and Favorites (`since` 2.1.0), plus a 2.1.0 `whatsnew.json` entry. | Leaving the old anchors. |

### 2.1 For the approval

- **A1** (D17): update links on rename and move, on by default as proposed? Or off in release 1?
- **A2**: *Ask about this file…* (shown on the canvas) is **dropped** from release 1. Sessions has no target that takes a drafted prompt, and dropping it means Files starts no agent at all.
- **A3**: Kind and Modified filters, saved searches, and a Gallery view are **deferred** (§7).
- **A4**: the canvas's Trash toast offered Undo; D16 replaces that with a pointer to the Trash, because Electron cannot put files back.

## 3. What already exists (verified at `a8a31f4`)

- **The vault API in compat** (`app/compat/src/vault.ts`): `readBinary` reads synchronously in chunks (`:64`, 8 MB each). The adapter has `copy` (`:126`). The vault has `createFolder`, `rename` and a system `trash` (`:207`, `:216`, `:220`). There is no `metadataCache`, `fileManager.renameFile` or open-file history.
- **Icons:** `setIcon` renders any lucide id (`notice.ts:40`). `createSvg` exists for the folder art. `MarkdownRenderer` exists (`markdown.ts:130`).
- **Shell actions:** `openPath`, `showItemInFolder` and `openExternal` are in HudHost (`host.ts:106-108`). The open-or-reveal policy is in `app/src/main/policy/shell.ts:38`.
- **The CSP** (`renderer/index.html:6`) has `img-src 'self' data:` and `object-src 'none'`.
- **Pure path rules** in `vaultFiles.ts`: `renamePath`, `movePath`, `newNotePath`, `PROTECTED_PREFIXES` (`:15`) and `searchVault` (`:106`).
- **Shortcuts already taken** (`obsidian-plugin/main.ts:116-147`): ⌘T, ⇧⌘T, ⌥⌘1–3, ⇧⌘N, ⇧⌘M, and on Code only ⌘F, ⌘L, ⇧⌘[ ⇧⌘] and ⇧⌘W. The View menu numbers the tabs ⌘1–⌘9 (`app/src/main/menu.ts:25-28`), and the `editMenu` role (`:94`) holds ⌘Z, ⇧⌘Z and ⌘A. Chromium offers ⌘ keys to the page before the menu, and a handled key never reaches it (`app/src/renderer/boot.ts:118-120`). ⌃⌘1–3, ⌘N, ⌥⌘N, ⌘D and ⇧⌘P are free.
- **Tests:** `files.spec.ts` and `files-writes.spec.ts`, as COVERAGE rows F1–F7. `docs/app-smoke.md` has a Files section of 7 items. The tour's Files chapter has 6 steps (`steps.json:86-93`).
- **Deep links:** `WorkbenchView.open({ tab: "spaces", workspace })` exists (spaces-redesign D12).

## 4. Design notes

- **Selection model.** `filesModel` keeps a cursor, a selection set and an anchor for each view. A redraw keeps all three when their paths survive, and a vault event carries a rename across (the To-Do and Term lessons on keeping focus apply). Typing letters jumps to a name, as in Finder.
- **Performance.** An Icons folder with 725 items (`brain/_index`) draws its tiles at once, and thumbnails and page lines arrive lazily. List and Columns build rows only for open folders. The vault index runs after the first paint and never blocks a click.
- **Link rewriting** (D17) is a pure plan, `vaultIndex.rewritePlan(from, to)`, giving the edits for each file. It is tested on wiki links with aliases and headings, embeds (`![[…]]`) and relative Markdown links. The tab applies it file by file and reports which ones failed.
- **⌘Z and ⌘A** are handled only when focus is outside a field. Inside one, the Edit menu's roles keep doing text undo and select-all.

## 5. Host parity

1. **Entry point:** the Files rail tab in the app, the same on every host. No command, skill or `aos` verb.
2. **Hooks:** none.
3. **Model calls:** none (A2).
4. **Session data:** none. Files reads the vault through compat, and nothing from either host.
5. **MCP:** none.
6. **Degradation:** nothing depends on a host. `variants.spec.ts` gains a check that Files renders and works on a Codex-only vault.
7. **Docs:** the `docs/app-smoke.md` Files section is rewritten (host-neutral; one Codex-only item), with COVERAGE F1–F16. `CHANGELOG.md` gets lines under [Unreleased] with tour markers. `app/README.md` changes only where it describes Files.

| Mode | How the user invokes it | What runs | What they see if it can't |
|---|---|---|---|
| Claude Code only | Files on the rail | the HUD, through compat and the `files` surface | — (no host step) |
| Codex only (plugin · direct) | Files on the rail | the same | — |
| Both | Files on the rail | the same | — |

No cell differs between hosts, so there is no parity row in §2.

## 6. PRs and release

1. **PR 1, read and look:** the shell, the three views, selection and keys, the preview, Quick Look, Favorites (defaults), history and the path bar, the Open rules, and the vault index (links in the preview). It adds the right-click menu, wired to today's chores (the new-note form, the rename and move drawers, Trash), so nothing regresses.
2. **PR 2, act:** rename in place, New folder, Duplicate, drag to move, ⌘Z, link updates (D17), the surface `source` text, and the live write check (D25).
3. **PR 3, find:** thumbnails, smart folders, Tags, editing Favorites, and the search scope bar.

Then 2.1.0: the bump, `release:app`, and §8. Before the tag: a smoke on the real vault, and a screenshot of every tab after visiting Files (the 1.4.1 lesson).

## 7. Out of scope

A Gallery view; a view remembered per folder; Kind and Modified filters and saved searches; ⌥-drag copy; drag to or from macOS Finder; *Ask about this file…*; inline PDFs; folders outside the vault (linked code folders); editing tags; changes to Spaces' Files pane.
