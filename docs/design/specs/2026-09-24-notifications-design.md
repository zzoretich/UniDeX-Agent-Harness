# Notifications — design

**Date:** 2026-09-24
**Status:** approved design, implemented on `feat/agentic-notfication`
**Scope:** give agents, routines and duties one place to post messages for the user. `aos notify` writes them
into the vault. A new **Notifications** tab in the Workbench lists them with unread state, filters and actions.
Urgent items also raise an OS notification. It works the same from Claude Code and Codex.

---

## 1. Problem

Agents produce output the user should see but did not ask for in the current session: a routine's report, a
duty's finding, a bulletin from a user-written news agent. Today that output lands in a daily note, a
`brain/_index/` cache, a log, or nowhere. The only push channel is `persona/watchdog.js#osNotify`. It is an OS
banner that leaves no record and can't be filtered or acted on. The Workbench has an attention surface for
decisions (Proposals) and one for health (Pulse), but none for *messages*.

## 2. Decisions

| # | Decision | Rejected alternative |
|---|---|---|
| D1 | **One notification = one Markdown file** under `brain/notifications/<year>/`, with frontmatter. It is readable in Obsidian and searchable by recall. | A single JSONL log: cheap to append, but not readable as notes. |
| D2 | **Senders post through `aos notify`**, a runtime script (`brain/scripts/notify.js`) behind a launcher case arm. It validates, writes atomically and raises the OS alert. Skills on both hosts call it from their shell. | An MCP write tool: the server stays read-only apart from `wrap_session`. Senders writing files directly: that skips validation and the alert. |
| D3 | **Notification files are never changed after they are written.** Read and archived state lives in `brain/notifications/state.json`, written only by the tab and the CLI. | Flipping `read:` in frontmatter: it rewrites sender content and races with senders. |
| D4 | **Actions are declarative and allow-listed.** `ask` opens a new Term session running a named skill with one argument. `react` records +1/−1 in `reactions.jsonl`. No action carries a shell command. The skill name must match `^[a-z0-9][a-z0-9:_-]*$`, and the whole prompt is shell-quoted. | Free-form `run:` commands: a Markdown file in a synced vault must never be able to execute code. |
| D5 | **Four levels: `breaking`, `alert`, `edition`, `info`.** Only `breaking` and `alert` raise an OS banner, and only while `notifications.osAlert` is true. `maxPerSenderPerHour` downgrades a flood to `info`. | Letting the sender decide: any agent could spam the banner. |
| D6 | **`ask` shows one button per enabled host**, like the Skills tab's run buttons: `claude '/<skill> <arg>'` and `codex '$<skill> <arg>'`. | Only the first host (the Proposals Review pattern): a both-hosts user could not choose. |
| D7 | **The tab and the CLI share one on-disk contract**, not code. Frontmatter values are single-line JSON (valid YAML), so both sides parse them with `JSON.parse` and no YAML library. The TypeScript parser and the JS writer are each tested against the same fixture files, and the TS test also loads the JS store to compare. | Importing runtime JS into the bundle: the HUD reads the vault, never the vendored scripts. |

## 3. What already exists (verified at `d410946`, v0.17.0)

- `brain/scripts/persona/watchdog.js#osNotify(title, message)`: osascript / notify-send, never throws, returns false on an unsupported platform.
- `plugin/bin/aos`: routes each name to `brain/scripts/<script>` (`run-routine) SCRIPT=routines/run-routine.js`); the Codex plugin gets a byte copy.
- `hud/src/views/WorkbenchView.ts`: `RAIL[]`, `makeTab()`, `refreshBadges()` and `touchesBadges()` (`src/data/badges.ts`), and `runInTerm(command)`, which the Proposals, Skills and Agents tabs already use.
- `src/data/aosConfig.ts`: `sessionHosts(cfg)`. `src/data/skills.ts`: `shq()` and the per-host `runCommand()`.
- `src/data/todoWriter.ts`: the precedent for a tab writing vault files.
- `brain/scripts/lib/settings-schema.js`: every `aos config` key. `config.default.json` `recallRoots` feeds recall's corpus (`sdk/lib/recall.js`).

## 4. Design

### 4.1 Storage (`schema: 1`)

```
brain/notifications/
  2026/2026-09-24T0700-news-anchor-morning-edition.md   # immutable item; id = filename stem
  state.json          # { schema: 1, items: { "<id>": { read?: true, archived?: true } } }
  reactions.jsonl     # { schema: 1, at, id, ref, value: 1|-1 }, append-only; senders read it back
```

```yaml
schema: 1
id: "2026-09-24T0700-news-anchor-the-morning-edition"
from: "news-anchor"
level: "edition"
title: "The Morning Edition"
created: "2026-09-24T07:00:12-04:00"
tags: ["news"]
actions: [{"kind":"ask","label":"Deep dive","skill":"deep-dive","arg":"<story title>","anchor":"<heading slug>"},{"kind":"react","label":"More like this","value":1,"ref":"<story id>","anchor":"<heading slug>"}]
```

`requestedLevel` records the level a sender asked for when the hourly limit downgraded the item to `info`.

An action with an `anchor` renders under the matching `##` heading. Without one, it renders at the foot of the item.

### 4.2 `aos notify` (`brain/scripts/notify.js` + `lib/notifications.js`)

```
aos notify post --from <slug> --level <level> --title <text> [--tag t]... [--body-file <path>|-] [--actions-json <path>|-] [--dry-run] [--json]
aos notify list [--unread] [--from <slug>] [--level <level>] [--json]
aos notify read <id>...|--all · unread <id>... · archive <id>... · unarchive <id>... · prune [--days N]
```

- `post` validates the input and rejects unknown action kinds, then writes via tmp + rename (a colliding id gets `-2`, `-3`, and so on) and prints the id.
- It calls `osNotify(title, first body line)` only for `breaking`/`alert` while `notifications.osAlert` is true. The notifier is injected, so tests never raise an alert.
- Usage errors exit 2. Everything else exits 0, as the CLI verbs around it do.
- `prune` marks items older than `notifications.retentionDays` as archived. It never deletes.
- Config keys (defaults, plus `settings-schema.js` entries in a new `notifications` section): `osAlert: true`, `retentionDays: 30`, `maxPerSenderPerHour: 6`. `recallRoots` gains `brain/notifications`.

### 4.3 Notifications tab (`src/views/NotificationsTab.ts`, `src/data/notifications.ts`, `src/data/notificationWriter.ts`)

- The rail gets `{ id: "notifications", icon: "◔", label: "Notifications" }` after Proposals, plus an `open-workbench-notifications` command.
- The list is newest first by `created` (the id breaks ties), on both sides. It has level chips, a sender dropdown, and an Unread/All toggle. Archived items are hidden unless you pick "Archived".
- Clicking a row expands the rendered body and marks the item read. The row also has Archive and Open-note buttons, and "Mark all read" sits in the header.
- Badge: the unread count. The badge turns red while an unread `breaking` item exists. `touchesBadges` covers `brain/notifications/`.
- Actions: `ask` shows `❯_ claude` / `❯_ codex` for each host in `sessionHosts()` and calls `runInTerm`. `react` appends to `reactions.jsonl` and marks the chosen button.
- Parsing tolerates malformed items: they are skipped and counted, and a footer shows "n unreadable".

### 4.4 In-session surface

`plugin/commands/notifications.md` → `/agenticos:notifications` · `$agenticos:notifications`. It shows unread items
through `aos notify list --unread --json`, marks items read or archived on request, and documents
`aos notify post` so any agent or skill knows how to post.

## 5. Host parity

1. **Entry point.**
   - `aos notify` is host-neutral.
   - In a session: `/agenticos:notifications` on Claude Code, `$agenticos:notifications` with the Codex plugin, or `$notifications` with direct wiring.
   - The tab lives in Obsidian and is the same whatever the host.
2. **Hooks:** none are added or changed, so nobody needs to re-trust `/hooks`.
3. **Model calls:** none. The feature only moves files. Senders pay for their own calls.
4. **Session data:** none. It reads no transcripts, session ids or agent dirs.
5. **MCP:** no new tool.
6. **Degradation:**
   - With no pty, `runInTerm` falls back to the Term tab's existing install hint.
   - Without osascript or notify-send, `osNotify` returns false and the item is still written.
   - With no hosts enabled, `ask` shows no buttons, and a line says "enable a host to run this".
7. **Docs:**
   - The README "Everyday commands" table gets a row with both forms.
   - `docs/plugin-smoke.md` gets a Notifications tab check, plus one in-session check per host.
   - `CHANGELOG` gets an entry under Unreleased.

| Mode | How the user invokes it | What runs | What they see if it can't |
|---|---|---|---|
| Claude Code only | Notifications tab · `/agenticos:notifications` · `aos notify` | `notify.js` via `bin/aos`; the `ask` button runs `claude '/<skill> <arg>'` | Term install hint; no OS banner on an unsupported platform |
| Codex only (plugin · direct) | the tab · `$agenticos:notifications` · `$notifications` · `aos notify` | the same `notify.js`; the `ask` button runs `codex '$<skill> <arg>'` | same |
| Both | all of the above | one store; the `ask` action gets a button per host | same |

No cell differs between hosts, so the design has no host gap and no fallback decision.

## 6. Testing

- `brain/scripts/test/notify.test.js`: validation, the action allow-list, atomic writes and id collisions, the rate limit, alert levels (with an injected notifier), prune, and read/archive state.
- `hud/src/data/notifications.test.ts`: parsing the shared fixtures, filters, the badge (including breaking), malformed items, and the per-host `ask` commands with quoting.
- The settings-schema and plugin-command count tests move with the new key and command. `npm run gate` stays clean, and all examples are generic.

## 7. Out of scope

Mobile push, email, cross-device read state, and any particular sender (a news agent or others lives in user
space and only calls `aos notify`).
