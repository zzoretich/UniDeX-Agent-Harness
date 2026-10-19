import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import { createRequire } from "module";
import * as fs from "fs";
import { parseStatusline, isStale, barSegments, workbenchTabFrom, workbenchTabFromUrl, workbenchLinkFrom, SPACES_PANES, THREAD_ID_RE, StatuslineModel } from "./statusline";

// The on-disk contract is shared with brain/scripts/lib/statusline-model.js (spec 2026-09-28-statusline-design D3): the
// runtime builds the model from a fixture vault and this parser must read it back field for field.
const REPO = path.resolve(__dirname, "../../..");
const runtime = createRequire(__filename)(path.join(REPO, "brain/scripts/lib/statusline-model.js"));
const NOW = new Date("2026-09-28T19:00:00Z");

const FULL: StatuslineModel = {
  schema: 1, at: NOW.toISOString(), vault: "AgenticOS",
  needs: { gates: [{ team: "dev", item: "devbar-01", stage: "ship" }, { team: "dev", item: "site-02", stage: null }], alerts: 2, breaking: 1, flags: 1 },
  runs: [{ team: "dev", member: "woz", stage: "execute", item: "devbar-01" }, { team: "dev", member: "jordan", stage: "execute", item: "x" }],
  spend: { family: "crossReview", usd: 8.5, cap: 10 },
  health: { update: "0.21.0", provider: "claude-not-logged-in", unwrapped: true, drafts: 11 },
};

test("parseStatusline reads what the runtime writes, field for field", () => {
  const built = runtime.build(path.resolve(__dirname, "fixtures/teams-vault"), { now: NOW, alive: () => false });
  const parsed = parseStatusline(JSON.stringify(built));
  assert.ok(parsed);
  assert.equal(parsed.at, built.at);
  assert.deepEqual(parsed.needs.gates, built.needs.gates.map((g: { team: string; item: string; stage: string | null }) => ({ team: g.team, item: g.item, stage: g.stage })));
  assert.equal(parsed.needs.gates.length > 0, true, "the teams fixture has a pending gate to carry");
  assert.deepEqual(parsed.health, built.health);
  assert.deepEqual(parseStatusline(JSON.stringify(FULL)), FULL);
});

test("parseStatusline refuses anything but a schema-1 model and coerces bad fields", () => {
  for (const raw of [null, "", "nope", "[]", JSON.stringify({ ...FULL, schema: 2 }), JSON.stringify({ schema: 1 })]) assert.equal(parseStatusline(raw), null, String(raw));
  const odd = parseStatusline(JSON.stringify({ schema: 1, at: "x", needs: { gates: [{ item: 3 }, "g", { item: "ok" }], alerts: -2, flags: "1" }, runs: "no", spend: { family: "hooks", usd: 1, cap: 0 } }));
  assert.deepEqual(odd?.needs, { gates: [{ team: "", item: "ok", stage: null }], alerts: 0, breaking: 0, flags: 0 });
  assert.deepEqual(odd?.runs, []);
  assert.equal(odd?.spend, null, "a zero cap is no spend line");
});

test("isStale: older than 15 s (D3), absent, or from the future", () => {
  assert.equal(isStale(FULL, NOW.getTime() + 10_000), false);
  assert.equal(isStale(FULL, NOW.getTime() + 16_000), true);
  assert.equal(isStale(FULL, NOW.getTime() - 120_000), true);
  assert.equal(isStale(null), true);
});

test("barSegments: what needs you first, each opening where it is handled", () => {
  assert.deepEqual(barSegments(FULL).map((s) => [s.text, s.tone, s.tab ?? s.file ?? null]), [
    ["◆ 2 gates", "violet", "agent-teams"],
    ["1 breaking", "rose", "notifications"],
    ["2 alerts", "amber", "notifications"],
    ["1 flag", "amber", "persona/STATE.md"],
    ["▶ woz execute +1", "cyan", "agent-teams"],
    ["cross-review $8.50/$10", "rose", "settings"],
    ["↑ 0.21.0", "amber", "settings"],
    ["provider none", "rose", "settings"],
    ["not wrapped", "amber", null],
    ["11 drafts", "dim", null],
  ]);
  const one = barSegments({ ...FULL, needs: { gates: [FULL.needs.gates[0]], alerts: 0, breaking: 0, flags: 0 }, runs: [], spend: null, health: { update: null, provider: null, unwrapped: false, drafts: 0 } });
  assert.deepEqual(one.map((s) => [s.text, s.title]), [["◆ gate devbar-01", "devbar-01 · ship gate waits on you"]]);
  assert.deepEqual(barSegments({ ...FULL, needs: { gates: [], alerts: 0, breaking: 0, flags: 0 }, runs: [], spend: null, health: { update: null, provider: null, unwrapped: false, drafts: 0 } }), []);
});

test("workbenchTabFrom: only a rail tab id opens a tab", () => {
  const ids = ["pulse", "agent-teams", "notifications", "settings"];
  assert.equal(workbenchTabFrom({ action: "agenticos", tab: "agent-teams" }, ids), "agent-teams");
  assert.equal(workbenchTabFrom({ action: "agenticos", tab: "../../etc" }, ids), null);
  assert.equal(workbenchTabFrom({ action: "agenticos" }, ids), null);
});

test("workbenchTabFromUrl: the app's agenticos://workbench links and the older obsidian://agenticos ones", () => {
  const ids = ["pulse", "agent-teams", "notifications", "settings"];
  // What the runtime writes now (brain/scripts/lib/hud-host.js links().tab) and what status lines wrote before the app.
  assert.equal(workbenchTabFromUrl("agenticos://workbench?tab=agent-teams", ids), "agent-teams");
  assert.equal(workbenchTabFromUrl("obsidian://agenticos?vault=AgenticOS&tab=notifications", ids), "notifications");
  assert.equal(workbenchTabFromUrl("AgenticOS://Workbench?tab=settings", ids), "settings");
  assert.equal(workbenchTabFromUrl("agenticos://workbench?tab=..%2F..%2Fetc", ids), null);
  assert.equal(workbenchTabFromUrl("agenticos://workbench", ids), null);
  assert.equal(workbenchTabFromUrl("agenticos://note?tab=pulse", ids), null, "a note link names no tab");
  assert.equal(workbenchTabFromUrl("obsidian://open?tab=pulse", ids), null);
  assert.equal(workbenchTabFromUrl("https://workbench?tab=pulse", ids), null);
  assert.equal(workbenchTabFromUrl("not a url", ids), null);
  // The runtime's own builder round-trips through the HUD's parser.
  const hudHost = createRequire(__filename)(path.join(REPO, "brain/scripts/lib/hud-host.js"));
  assert.equal(workbenchTabFromUrl(hudHost.links().tab("pulse"), ids), "pulse");
});

// ── the Spaces deep link (spaces-redesign D12) ──

const RAIL = ["pulse", "term", "chat", "spaces", "files", "settings"];
const NAMES = ["harbor-map", "tide-chart", "_archive/pier-repairs"];
const THREAD = "3f2c9d1e-0a4b-4c8d-9e7f-1a2b3c4d5e6f";
/** The query a link hands the HUD's handler, as the app's protocol.ts passes it (every parameter, as text). */
const paramsOf = (url: string): Record<string, string> => Object.fromEntries(new URL(url).searchParams);

test("workbenchLinkFrom: a Spaces link selects a workspace from the snapshot, a pane from the set, a thread id", () => {
  assert.deepEqual(workbenchLinkFrom(paramsOf("agenticos://workbench?tab=spaces&workspace=harbor-map"), RAIL, NAMES), { tab: "spaces", workspace: "harbor-map" });
  assert.deepEqual(
    workbenchLinkFrom(paramsOf(`agenticos://workbench?tab=spaces&workspace=tide-chart&pane=files&thread=${THREAD}`), RAIL, NAMES),
    { tab: "spaces", workspace: "tide-chart", pane: "files", thread: THREAD },
  );
  // A hidden entry is still a snapshot name (Spaces shows it behind its toggle); the encoded slash round-trips.
  assert.deepEqual(workbenchLinkFrom(paramsOf("agenticos://workbench?tab=spaces&workspace=_archive%2Fpier-repairs"), RAIL, NAMES), { tab: "spaces", workspace: "_archive/pier-repairs" });
  for (const p of SPACES_PANES) assert.equal(workbenchLinkFrom({ tab: "spaces", workspace: "harbor-map", pane: p }, RAIL, NAMES)?.pane, p);
});

test("workbenchLinkFrom: a value that fails its check is dropped, never passed on", () => {
  const sel = (q: string) => workbenchLinkFrom(paramsOf(`agenticos://workbench?${q}`), RAIL, NAMES);
  // workspace: only an exact snapshot name; not a near miss, a path, a case change or an empty value
  for (const ws of ["harbor", "Harbor-Map", "harbor-map%2F..", "..%2F..%2Fetc", "", "harbor-map%00"]) assert.deepEqual(sel(`tab=spaces&workspace=${ws}`), { tab: "spaces" }, ws);
  // pane and thread go with a dropped workspace
  assert.deepEqual(sel(`tab=spaces&workspace=nope&pane=files&thread=${THREAD}`), { tab: "spaces" });
  assert.deepEqual(sel(`tab=spaces&pane=files&thread=${THREAD}`), { tab: "spaces" });
  // pane: one of the fixed set
  assert.deepEqual(sel("tab=spaces&workspace=harbor-map&pane=terminal"), { tab: "spaces", workspace: "harbor-map" });
  assert.deepEqual(sel("tab=spaces&workspace=harbor-map&pane=Files"), { tab: "spaces", workspace: "harbor-map" });
  // thread: a thread id or nothing (uppercase, a flag, a short id, a path)
  for (const t of [THREAD.toUpperCase(), `-${THREAD.slice(1)}`, "3f2c9d1e", `${THREAD}x`, "..%2Fsessions"]) {
    assert.deepEqual(sel(`tab=spaces&workspace=harbor-map&thread=${t}`), { tab: "spaces", workspace: "harbor-map" }, t);
  }
  // a workspace on another tab is not read: only Spaces takes one from a link
  assert.deepEqual(sel("tab=term&workspace=harbor-map"), { tab: "term" });
  assert.deepEqual(sel("tab=chat&workspace=harbor-map&thread=" + THREAD), { tab: "chat" });
  // not a rail tab: nothing (the handler then opens the Workbench as it was)
  assert.equal(sel("tab=..%2F..&workspace=harbor-map"), null);
  assert.equal(sel("workspace=harbor-map"), null);
});

test("workbenchLinkFrom: a link with extra parameters only selects (no resume, launch, draft or verb)", () => {
  const link = workbenchLinkFrom(paramsOf(
    `agenticos://workbench?tab=spaces&workspace=harbor-map&pane=history&thread=${THREAD}&resume=1&host=claude&run=aos%20workspace%20archive&draft=1&command=rm&cwd=%2F`,
  ), RAIL, NAMES);
  assert.deepEqual(link, { tab: "spaces", workspace: "harbor-map", pane: "history", thread: THREAD });
  assert.deepEqual(Object.keys(link ?? {}).sort(), ["pane", "tab", "thread", "workspace"]);
});

test("THREAD_ID_RE is the app's ThreadId (app/src/main/ipc/schemas.ts)", () => {
  const schemas = fs.readFileSync(path.join(REPO, "app/src/main/ipc/schemas.ts"), "utf8");
  const m = /const ThreadId = z\.string\(\)\.regex\(\/(.+)\/\);/.exec(schemas);
  assert.ok(m, "schemas.ts declares ThreadId as z.string().regex(/…/)");
  assert.equal(THREAD_ID_RE.source, new RegExp(m[1]).source);
});
