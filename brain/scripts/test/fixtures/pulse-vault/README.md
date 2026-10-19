# Pulse fixture vault

Read by `brain/scripts/test/pulse-facts.test.js` and by the Workbench's `hud/src/data/pulseFacts.test.ts`, which
check that both sides give the same facts (spec 2026-10-08-pulse-cockpit-design P8). The tests read it as of
2026-10-08 19:24 local time; times without an offset are local, so the facts are the same in every timezone.
