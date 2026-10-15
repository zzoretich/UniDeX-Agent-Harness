# The Workbench HUD (source)

The Workbench's source: every tab, the sidebar HUD, the settings and the status bar items, in TypeScript. The
**AgenticOS Workbench** app (`../app`) compiles it into its window. It renders the caches the runtime writes
(`brain/_index/*`) and never calls a model itself.

The folder keeps its old name, and the HUD still imports `obsidian`: since 1.0 that name resolves to the app's
compatibility package (`../app/compat`), not to Obsidian, and the HUD is no longer packaged or released as an Obsidian
plugin. Moving it off Obsidian's API names is later, optional work (spec 2026-10-05-workbench-app-design D5).

## How the app runs it

- `../app/scripts/build.mjs` bundles `main.ts` into the app's page, with `obsidian` aliased to the compat package and
  `path` to a POSIX shim. The page is sandboxed with no Node.
- Every file, process, terminal and OS call goes through `src/host.ts` (the `HudHost` seam). The app installs a host
  over its bridge to the main process, which checks each call; `src/nodeHost.ts` is the plain-Node default the tests
  use, and the only file here that imports Node's I/O modules, node-pty or electron (`path` is pure, and shimmed).
- The app gives the HUD its id (`agentic-os`, which keys its settings) and its version, this package's `version`.
- `npm run check:compat` in `../app` fails when the HUD uses an Obsidian API, DOM helper or icon the compat package
  lacks: run it after a change here.

## The guided tour

`src/tour/` is the tour (spec `../docs/superpowers/specs/2026-10-14-guided-tour-design.md`): `steps.json` holds a chapter
for every surface, each step an anchor (a `data-tab`, `data-area`, `data-mode`, `data-action` or `data-tour` selector),
its text and how it advances; `whatsnew.json` the What's new entries per release. The engine routes with
`WorkbenchView.open()` and keeps its state in the HUD's settings (`tour`). A control a step spotlights keeps its anchor:
renaming or removing one breaks `app/tests/e2e/tour.spec.ts`, which resolves every step on two machines.
`src/ui/launchSequence.ts` (tour C11) owns every dialog the app opens on its own at launch, one at a time, each once:
the app's runtime update, the Go-local card (`src/ui/GoLocalCard.ts`, local-first A9, through the `migrate` surface),
the Import sheet (`src/ui/ImportSheet.ts`, install-import B12, the same surface), the welcome tour or What's new, then Getting started; `src/tour/launch.ts` says
what is due, and `tour.launched` remembers what was shown.

## Data contracts

Every file under `brain/_index/` is read-only for the HUD; a script under `brain/scripts/` owns it. The specs under
`../docs/superpowers/specs/` give each one's shape and freshness window.

## Dev loop

```
npm test             # check:hex, then node:test via tsx (also run by the root `npm test`)
npm run typecheck    # tsc
npm run gen:tokens   # regenerate src/ui/tokens.ts after changing the .aos-root block in styles.css
```

- `src/ui/tokens.ts` is generated from the `.aos-root` block in `styles.css`; never hand-edit it.
- `check:hex` fails on any hex color outside `tokens.ts`.
- To see a change, run the app from `../app` (`npm start`; see its README). The manual checklist is
  `../docs/app-smoke.md`.
