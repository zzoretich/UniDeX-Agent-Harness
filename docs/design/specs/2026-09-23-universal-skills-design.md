# Universal skills — design

Date: 2026-09-23 · Branch: `feat/universal-skills` · Verified against `07b6e75` (v0.13.0), Claude Code 2.1.281, codex-cli 0.156.1

## 1. Problem

A skill the owner writes in one host is invisible to the other. Claude Code reads user skills from
`<claude config dir>/skills/<name>/SKILL.md` (plus claude.ai-synced skills under `skills/synced/<id>/`); Codex reads
`~/.agents/skills/<name>/SKILL.md`. No folder is read by both (verified in both binaries: Claude Code touches
`.agents/skills` only in its one-shot `/import`; Codex never reads `.claude/skills`). On the owner's machine that is 83
user skills plus 11 synced ones on the Claude side and none on the Codex side. There is also no place to *see* every
skill: the HUD's `readSkillsFromFs` reads `<vault>/skills`, a legacy path that is empty in a dedicated vault.

The owner wants a Skills tab listing every skill of both hosts, a way to use one from there, and every skill
universal: authored in Claude Code → usable in Codex, and the reverse.

## 2. Decisions

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| D1 | **Translated mirror.** A skill native to one host gets a *mirror* folder in the other host's user scope: a generated `SKILL.md` (translated, D4), a symlink for every other top-level entry of the source (`scripts/`, `references/`, `assets/`), and a `.aos-mirror.json` sidecar `{ schema: 1, from, source, sourceHash, writtenHash }`. | Plain symlinked folders; a canonical store in the vault that both hosts link to. | A symlink cannot translate: `$ARGUMENTS` (42 of the owner's skills) and `AskUserQuestion` (11) would reach Codex verbatim, and Codex rejects a SKILL.md without `name` + `description`. A vault store would move 94 user files out of the folders each host's own tooling (`/skill-creator`, Codex `skill-installer`) writes to. Symlinked supporting files keep scripts live without copying them. |
| D2 | **Scope: each host's user skills** (Claude: `skills/*` and `skills/synced/*/*`; Codex: `~/.agents/skills/*`). Plugin skills and host built-ins (Codex `~/.codex/skills/.system`) are *listed* in the tab with their host and plugin, never mirrored. | Mirror plugin and built-in skills too. | A plugin skill leans on its plugin's MCP server, app connector or hooks (Codex `vercel`, `supabase`; Claude `${CLAUDE_PLUGIN_ROOT}`), so a mirror would be a skill that cannot run. Built-ins use host-native tools (Codex `imagegen`). The AgenticOS plugin's own skills already ship on both hosts. |
| D3 | **Never touch a folder without our sidecar.** Status per skill: `universal` (mirror current, or the same content native on both) · `differs` (native on both, different content: no write) · `edited` (the mirror's SKILL.md hash ≠ `writtenHash`: left alone until `aos skills reset <name>`) · `excluded` · `invalid` (no `name`/`description` for Codex, or a name outside `[a-z0-9-]{1,64}`) · `listed` (plugin/built-in, D2) · `pending` (sync off or one host). A source that disappears takes its unedited mirror with it. Folders carrying the direct-wiring or plugin marker (`cli/codex-host.js:39,45`) are AgenticOS's own and skipped. | Last writer wins; mirror both directions of a same-named pair. | The owner edits skills by hand in both trees. A sync that can overwrite one of those edits is worse than no sync. |
| D4 | **One translator, `brain/scripts/lib/skill-translate.js`.** Claude → Codex: frontmatter reduced to `name` + `description` (description falls back to the first prose line, clipped to 1024); `$ARGUMENTS` → "the text the user wrote after `$<name>`"; `${CLAUDE_SKILL_DIR}` → the mirror's folder; `AskUserQuestion` → "question" plus the numbered-question host note; " with the Read/Edit/Write/Glob/Grep tool" dropped; "this/the/your Claude Code session" → "… Codex session"; `/<n>` → `$<n>` for a skill universal on both. Codex → Claude: frontmatter kept; `$<n>` → `/<n>` for known names. Both add a one-line marker naming the source. | Reuse `rewriteBody` from `cli/codex-host.js`. | That function names the AgenticOS launcher, MCP prefix and plugin root, and its output is pinned byte-for-byte by the `codex-plugin/` check. User skills need a smaller, symmetric set; sharing it would couple two contracts. |
| D5 | **When it runs:** a new SessionEnd hook `skills-sync` on both hosts (detached, 3 s under Codex), the tab on open when the cache is older than 10 min and from its **Sync** button, and the end of `aos upgrade` (not `aos init`: its numbered plan stays as it is, and the first session end syncs). A skill made in a session is on the other host by that host's next session. | SessionStart; piggyback on `scan-vault`. | Codex scans skills before hooks run, so SessionStart would lag a session anyway. `scan-vault` is a reader; writing into host config dirs from it muddies both. |
| D6 | **Config:** `skills: { sync: true, exclude: [] }` in `config.default.json`. Mirroring needs both hosts enabled (`host.js enabledHosts`); with one host the tab and `aos skills` still list everything. `aos skills exclude|include <name>` edits `skills.exclude` in `<vault>/brain/config.json` (where `aos upgrade` merges defaults, so the choice travels with the vault). | An opt-in key; the exclude list in `agenticos.json`. | The owner asked for every skill universal; a user with one host sees no change at all. `exclude` is the escape hatch for Codex's listing budget (~2 % of context; beyond it descriptions shrink, then skills drop). |
| D7 | **Cache `brain/_index/skills.json`**: `{ schema: 1, scannedAt, hosts: { claude, codex }, sync: { on, reason, at, written, removed, errors }, skills: [row] }`; row `{ id, name, description, origin: { host, scope: user\|synced\|mirror\|plugin\|builtin, plugin, path }, on: { claude, codex }, status, note }` where `on.<host>` is `{ path, via: native\|mirror\|plugin\|builtin, invoke }` or `null` (`invoke` is `/<folder>` for Claude Code, `$<name>` for Codex, `/<plugin>:<name>` · `$<plugin>:<name>` for a plugin). A failed write turns its row `error`. The HUD reads only this file. | The HUD scans the host folders itself. | The routines precedent (host-routines D4): one parser in the runtime, one loader in the HUD. |
| D8 | **Readers skip mirrors.** `persona/scan-arsenal.js` and `collectors/capabilities.js` ignore folders with `.aos-mirror.json`. | Leave them. | Otherwise the persona playbook and the Pulse skill counts double every universal skill. |

## 3. What already exists (at `07b6e75`)

- `brain/scripts/lib/host.js`: `claudeConfigDir(env)` `:31`, `codexHome()` `:35`, `enabledHosts(cfg)` `:68`.
- `cli/codex-host.js`: `skillsDir()` = `~/.agents/skills` `:68`; `GENERATED_MARKER` `:39`, `PLUGIN_MARKER` `:45`;
  `rewriteBody` `:218`, `hostNote` `:238` (the numbered-question wording D4 reuses as text).
- `brain/scripts/persona/scan-arsenal.js`: frontmatter parsing (`name`/`description`, block scalars) `:22-48`.
- `brain/scripts/lib/host-routines.js`: atomic per-pid cache write `:197-210`. `lib/detach.js` `respawnDetached()`.
- HUD: `WorkbenchView.ts` `RAIL` `:20` / `makeTab` `:155` / `runInTerm` `:134`; `RoutinesTab.ts` host pills and the
  stale-cache refresh spawn `:81-99`; `aosConfig.ts` `sessionHosts` `:103`, `invocation` `:110`.
- Hooks: `plugin/hooks/hooks.json` SessionEnd; `HOOKS` in `cli/codex-host.js:32`; `plugin/bin/aos` case arms `:80-96`.

## 4. Design

**Runtime.** `lib/skills.js`: `discover({ cfg, env })` walks the four user roots plus plugin caches
(`<claude config dir>/plugins/installed_plugins.json` → each install path's `skills/`; `<codex home>/plugins/cache/*/*/*/skills/`)
and `<codex home>/skills/.system`; `plan(found, cfg)` assigns D3 statuses and the mirror actions; `apply(plan)` writes
mirrors (SKILL.md via a per-pid temp + rename, symlinks, sidecar) and removes orphans; `writeCache`. Every function takes
injected roots so tests never touch a real home. `skills-sync.js` is the hook entry: `respawnDetached()`, then
`sync --quiet`; exit 0 with empty stdout on every path.

**CLI.** `cli/skills.js`: `aos skills [list] [--all] [--json]` (table: name, the invocation on each host, source, status; `--all` adds plugin skills and built-ins; before the first sync, a dry-run plan),
`sync [--dry-run]`, `exclude|include <name>`, `reset <name>`. `cli/aos.js` dispatch + `USAGE`; `plugin/bin/aos`
routes `skills` to `cli/aos.js` and `skills-sync` to the hook script. `aos doctor` gains a `skills` row (warn level):
"N universal · sync on" or the reason it is off, with `differs`/`edited` counts.

**In-session.** `plugin/commands/skills.md` passes its argument to `aos skills` and explains the statuses →
`/skills` (Claude Code), `$agenticos:skills` (Codex plugin), `$skills` (direct wiring).

**HUD.** New rail tab `skills` (✦ Skills) after Routines. `src/data/skills.ts` parses the cache (never throws) and
builds invocations; `src/views/SkillsTab.ts` renders: a head with counts, *as of*, and **Sync**; a filter box; two
sections, *Your skills* and *Plugins & built-ins*. A row shows name, one-line description (full on hover), a cyan
`claude` and an amber `codex` pill (dim when the skill is absent there), the source, and a status chip. Actions:
`❯_ claude` → `runInTerm('claude "/<name>"')`, `❯_ codex` → `runInTerm("codex '$<name>'")` (plugin skills use
`/<plugin>:<name>` and `$<plugin>:<name>`), `⧉` copy the invocation, `open` the SKILL.md, and `share`/`unshare`
(spawns `aos skills exclude|include`). A run button shows only for an enabled host that has the skill.

## 5. Host parity

1. **Entry:** the tab; `aos skills` (host-neutral); `/skills` · `$agenticos:skills` · `$skills`.
2. **Hooks:** one new SessionEnd entry, `skills-sync`, in `hooks.json` and `HOOKS` (3 s, detached). Codex users trust it
   once under `/hooks` after `aos upgrade`; the PR body and README say so.
3. **Model calls:** none.
4. **Session data:** none; host folders resolve through `host.js`.
5. **MCP:** none.
6. **Degradation:** one host enabled → list-only, the head says "sharing needs both hosts". No node-pty → the Term
   install hint, and `⧉` still copies.
7. **Docs:** README "Everyday commands" + repository counts, `docs/install.md` Hosts, `docs/plugin-smoke.md` items per host,
   `vault-template/AGENTICOS.md` vocabulary line.

| Mode | How the user invokes it | What runs | What they see if it can't |
|---|---|---|---|
| Claude Code only | Skills tab · `aos skills` · `/skills` | discovery + cache; no mirrors | "sharing needs both hosts"; Claude skills listed, `❯_ claude` only |
| Codex only (plugin · direct) | Skills tab · `aos skills` · `$agenticos:skills` · `$skills` | discovery + cache; no mirrors | same, `❯_ codex` only |
| Both | all of the above | discovery, mirrors both ways (SessionEnd, tab, upgrade), cache | `differs` / `edited` / `invalid` chips with the reason on hover |

## 6. Testing

- `brain/scripts/test/skill-translate.test.js`: every D4 transform, both directions; frontmatter-less source → invalid.
- `brain/scripts/test/skills.test.js` (tmp roots): discovery incl. `synced/` and plugin caches; each D3 status; apply is
  idempotent; an unmarked folder is never written; an edited mirror is kept; orphan removal; exclude; one host → no writes.
- `brain/scripts/test/skills-sync.test.js`: exit 0, empty stdout, on a missing vault and a throwing sync.
- `cli/skills.test.js`: list/`--json`, sync `--dry-run`, exclude/include round-trip, reset, usage errors exit 2.
- Scan-arsenal and capabilities tests: a mirror folder is skipped.
- `cli/plugin-manifests.test.js`, counts (18 commands, 25 Codex skills), `hud` `skills.test.ts`.
- Rehearsals: `first-run.sh` and `codex-host.sh`; manual: the tab on this machine, `$agenticos:skills` in Codex.

## 7. Out of scope

- Project-scope skills (`<repo>/.claude/skills` ↔ `<repo>/.agents/skills`): writing into repos is a separate decision.
- Mirroring plugin skills or built-ins (D2), Claude's legacy `commands/*.md`, Codex `prompts/*.md`.
- Creating or editing skills from the tab; an MCP `skill_list` tool; replacing the HUD's legacy `readSkillsFromFs`.
- Turning on Claude Code's `reloadSkills` setting (a same-session pickup) — the owner's settings are theirs.
- A version bump and release; the owner decides after merge.
