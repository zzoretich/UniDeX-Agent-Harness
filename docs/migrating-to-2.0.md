# Migrating to 2.0

UniDeX 2.0 moves background work onto a model on your Mac, moves the Chief of Staff to Claude Opus 5.5 or gpt-6-sol,
brings in your Claude Code and Codex history, and adds a guided tour. A new install gets all of it from the start. An
install from before 2.0 gets the new runtime and the new app, and is then **asked**, once, about the parts that change
how it works: nothing that runs on your behalf, spends or reads your history changes until you say so.

This page is for an install from 1.x. A new install needs none of it ([install.md](install.md)). Coming from before
1.0, where the Workbench ran in Obsidian, read [migrating-to-1.0.md](migrating-to-1.0.md) first.

## What the update does on its own

The app updates itself as usual (UniDeX ▸ Check for Updates…, then **Restart to Update**), and at its next launch
offers **Update the runtime in your vault**; **Update now** runs `aos upgrade` from the runtime the app carries.
From a terminal, `aos upgrade` does the same. The upgrade:

- re-vendors the runtime and refreshes the Claude Code and Codex plugins. **Nothing to re-trust:** no hook command
  changed on either host, so Codex does not ask under `/hooks` again;
- adds the new settings to `brain/config.json` with their defaults (`local.*`, `ai.*`, `persona.failover`, …); your
  own values win, and none of the new ones changes what runs until you go local (the `ai.*` switches apply under
  provider `local` only);
- installs graphify's local backend (`graphifyy[ollama]`, the same pinned 0.9.66) into the tool folder it already has;
- adds one routine, `import-digest`. It does nothing until you import: its first run finds nothing queued, turns
  itself off and takes its own schedule out;
- records what 2.0 asks you once, `local-first` and `import`, as `pending` in `brain/_index/migrations.json`, and
  re-renders your installed schedules.

## What it asks, in order

The first launch after the update opens these one at a time, each after the last closes. Each is remembered once you
answer or dismiss it; quitting the app with one open asks again next time.

1. **The runtime update** (above), while the vault's runtime is older than the app's.
2. **Go local** ("Run background work on this Mac"), while `local-first` is pending (an `aos upgrade` you already
   answered in a terminal settles it). The card says what moves to this Mac (session summaries, memory extraction and
   the wrap, workspace insights and file maps, embeddings and recall, the Pulse briefing and the graph's semantic
   pass, and the AI buttons, each of which can switch back in Settings) and what stays on Claude Code or Codex
   (Sessions, the Code tab's agents, cross-review and agent teams, and the Chief of Staff's duties), what background
   work spent in the last 7 days, and, when this Mac's model is not downloaded yet, **Download the model**. A ticked
   box, worded for your hosts, also moves the Chief of Staff to Opus 5.5 / gpt-6-sol.
   - **Go local** runs `aos migrate local-first --apply` (with `--chief` while the box is ticked): it first backs up
     every setting it changes to `brain/_index/migrations/local-first-<time>.json`, then sets `provider: local` and
     `ai.chat`, `ai.ask`, `ai.reflectWeek` and `ai.consolidate` to `local` in both `agenticos.json` and
     `brain/config.json`, moves the Chief of Staff's models when ticked (`persona.model: claude-opus-5-5`,
     `persona.codexModel: gpt-6-sol`), updates the hourly `brain/routines/tick.md` to 2.0's local triage only while it
     is byte for byte one a release shipped (an edited one is kept, and a notification says why), and re-renders your
     schedules. No routine of yours is touched.
   - **Keep my settings** runs `aos migrate local-first --decline`: nothing changes, and `auto` stays `auto`.
   - While the app's `migrate` write surface is off (it stays off until it has been checked on a live vault), the
     card shows those two commands instead of the buttons, each with **❯_ Run in Code**, which runs it in a Code tab
     terminal; the model download is the same with `aos local pull`.
3. **What's new in 2.0**: each change with **Show me**, which runs its tour steps; **Take the full tour** when this
   Mac has never seen the tour; **Got it**. Help ▸ What's new keeps the list.
4. **Getting started**, the checklist at the rail's foot.

The note about moving off Obsidian is gone. From a terminal, `aos upgrade` asks the Go-local question once when it
runs in one (Enter goes local and moves the Chief of Staff; `n` keeps your settings; `l` asks later); without a
terminal, as when the app runs it, it prints the commands instead:

```
aos migrate local-first --apply --chief   # go local, and move the Chief of Staff to claude-opus-5-5 / gpt-6-sol
aos migrate local-first --apply           # go local, and keep the Chief of Staff's model
aos migrate local-first --decline         # keep my settings
aos import                                # bring in your history (aos import --dry-run shows what it would bring)
```

`aos migrate` (or `aos migrate --status`) lists both and their state: `pending`, `applying`, `applied`, `declined` or
`undone`. An apply that stopped part way is `applying`: the next `--apply` finishes it on the same backup, and
`--decline` or `--undo` puts back what it had changed.

## Your history

Nothing from Claude Code or Codex is imported until you ask. `aos import --dry-run` shows what it would bring, per
host and kind; `aos import` brings it (`aos migrate import --apply` does the same and settles the migration;
`aos migrate import --decline` records that you don't want it). Settings ▸ Import in the Workbench shows each host's
last import with **Import** and **Import older history** (while the app's `import` write surface is off, run
`aos import` in the Code tab). What it brings, and the digest that works through your past sessions on the local model,
is in [install.md](install.md#bring-in-your-history). Imported memories wait in Brain ▸ Review, `reviewed: false`, one
batch per host.

## The Chief of Staff

An install upgraded from 1.x keeps `persona.model` and `persona.codexModel` at `null`, so its duties run on the model
they ran on before: the interview's answer, then `claude.model` on Claude Code; `codex.model`, then your Codex default,
on Codex. Its hourly `tick.md` stays a duty, now skipped properly on a quiet hour (`tick.js precheck`). Go local with the
box ticked, or `aos migrate local-first --apply --chief`, moves both: the duties to `claude-opus-5-5` / `gpt-6-sol`, and
the tick to the local triage that wakes the Chief of Staff only when something changed. To pick another model instead,
`aos config set persona.model <model>` and `aos routines sync`. `persona.failover` and the one daily cap over both
hosts apply either way ([chief-of-staff.md](chief-of-staff.md#host-model-and-failover)).

## What never changes without asking

- **Where background work runs.** `provider` stays what it was (`auto` for an install that never set one) until you
  go local; local-first's own default applies to new installs only.
- **What it spends.** Under `auto`, background work still falls back to Claude, then Codex, under the same caps. Under
  `local`, nothing spends unless you turn on `local.hostedFallback`.
- **The Chief of Staff's models and its tick** (above).
- **Your routines.** A routine without `engine:` runs exactly as before (`routines.runner` decides); no upgrade or
  migration edits one, except the shipped `tick.md` when you go local.
- **Your history**, until you import it.
- **Your hosts' own config.** No hook to re-trust; the import lists MCP servers in `brain/_index/mcp-servers.json` and
  never writes a host's config.

## Undo

- **Going local.** Settings ▸ Local engine ▸ **Undo**, or `aos migrate local-first --undo`, puts back every setting the
  backup holds while it still has the value going local set; a setting you changed since is kept and named. It then
  re-renders the schedules. **Go local…** in the same panel goes local again later.
- **Keeping your settings.** Settings ▸ Local engine ▸ **Go local…** (it opens the same card), or
  `aos migrate local-first --apply [--chief]`, whenever you like. `aos provider auto` also goes back to `auto` by hand.
- **An import.** Archive an imported memory in Brain ▸ Review (or `aos memory archive <path>`); a workspace it created
  (only the ones you accepted) with `aos workspace archive <name>`; `aos routines disable import-digest` stops the
  digest. A second `aos import` brings nothing twice.

## Check

`aos doctor` exits 0, and its `workbench app` row reads `UniDeX 2.0.x`. After going local it also checks the local
engine (`local engine`, `local model`, and `wraps queued` while session wraps wait for it), and its `persona runner`
row names the host, the model and the failover host. Under Codex, if `codex hooks trusted` counts fewer than all,
open `codex`, run `/hooks` and trust the agenticos entries.
