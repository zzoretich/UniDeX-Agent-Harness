// The Pulse model's pure parts (views/pulse/model.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chiefWaiting, lastWaitingSkip, mapPendingRows, writtenRows } from "./model";
import type { WorkspaceEntry } from "../../data/snapshot";
import type { WorkspaceMap } from "../../data/workspaceMaps";

const map = (workspace: string, pending: number): WorkspaceMap => ({
  workspace, generatedAt: null, pending,
  files: Array.from({ length: pending + 1 }, (_, i) => ({ path: `f${i}`, desc: i < pending ? null : "described", descAt: null, mtime: 0, size: 1, status: "fresh" as const })),
});

test("mapPendingRows: a hidden entry's stale map gives no Fix Queue row, a visible one's does (spaces-redesign D22)", () => {
  const ws = [
    { name: "harbor-map" },
    { name: "_spikes", hidden: true, hiddenReason: "underscore" },
    { name: "_archive/pier-repairs", hidden: true, hiddenReason: "archived" },
    { name: "field-notes" },
  ] as WorkspaceEntry[];
  const maps = { "harbor-map": map("harbor-map", 3), _spikes: map("_spikes", 5), "_archive/pier-repairs": map("pier-repairs", 2), "field-notes": map("field-notes", 0) };
  assert.deepEqual(mapPendingRows(ws, maps), [{ workspace: "harbor-map", pending: 3 }]);
  assert.deepEqual(mapPendingRows(undefined, maps), []);
});

test("writtenRows: today's writes newest first, one per memory, each as its file is now (brain-hub D15)", () => {
  const row = (ts: string, type: string, slug: string, title = "") => ({ ts, action: "written", slug, type, title, pending: false });
  const trail = [
    row("2026-10-08T08:00:00", "reference", "release-checklist", "Release checklist"),
    row("2026-10-08T09:00:00", "feedback", "prefer-small-diffs", "Prefer small diffs"),
    row("2026-10-08T10:00:00", "projects", "harbor-map", "Harbor Map"),
    row("2026-10-08T11:00:00", "user", "old-note"),
    row("2026-10-08T12:00:00", "reference", "release-checklist", "Release checklist"),   // written again: one row, the newest
    row("2026-10-08T12:30:00", "projects", "tide-parser"),
  ];
  const fm = (lines: string) => `---\ntype: memory\n${lines}\n---\n\n# Title\n\nBody.\n`;
  const texts = new Map<string, string | null>([
    ["brain/memory/reference/release-checklist.md", fm("tags: [memory/reference]\nreviewed: false")],
    ["brain/memory/feedback/prefer-small-diffs.md", fm("tags: [memory/feedback]\nreviewed: true")],
    ["brain/memory/projects/harbor-map.md", fm("tags: [memory/projects, status/archived]\nreviewed: false")],
    ["brain/memory/user/old-note.md", null],
    ["brain/memory/projects/tide-parser.md", fm("tags: [memory/projects, status/superseded]\nsuperseded_by: brain/memory/projects/harbor-map.md")],
  ]);
  assert.deepEqual(writtenRows(trail, texts).map((w) => [w.path, w.title, w.state, w.at]), [
    ["brain/memory/projects/tide-parser.md", "tide-parser", "superseded", "2026-10-08T12:30:00"],
    ["brain/memory/reference/release-checklist.md", "Release checklist", "written", "2026-10-08T12:00:00"],
    ["brain/memory/user/old-note.md", "old-note", "gone", "2026-10-08T11:00:00"],
    ["brain/memory/projects/harbor-map.md", "Harbor Map", "archived", "2026-10-08T10:00:00"],
    ["brain/memory/feedback/prefer-small-diffs.md", "Prefer small diffs", "kept", "2026-10-08T09:00:00"],
  ]);
  // Only `written` rows count; a file never read reads as gone.
  assert.deepEqual(writtenRows([{ ...row("2026-10-08T08:00:00", "user", "a"), action: "kept" }], new Map()), []);
  assert.deepEqual(writtenRows([row("2026-10-08T08:00:00", "user", "a")], new Map()).map((w) => w.state), ["gone"]);
});

test("chiefWaiting: with no host, add one; otherwise only today's last duty run, worded from its skip, cleared once a host signs in or a run goes ahead", () => {
  const skipped = (t: string, d: string, why: string) => `## ${t} — duty: ${d}\n- status: SKIPPED waiting-for-host\n- did: nothing — no host can start it (${why}); sign in to Claude Code or Codex, or add one with aos hosts add claude|codex\n`;
  assert.deepEqual(chiefWaiting(null, [], []), { kind: "no-host", text: "Add Claude Code or Codex to start your Chief of Staff." });
  const out = `# Journal\n\n${skipped("07:45", "sitrep", "claude: signed out; codex: CLI not found")}`;
  assert.deepEqual(chiefWaiting(out, ["claude", "codex"], []), { kind: "skipped", text: "Your Chief of Staff is waiting for a host: sign in to Claude Code; Codex's CLI was not found." });
  assert.deepEqual(chiefWaiting(out, ["claude"], []), { kind: "skipped", text: "Your Chief of Staff is waiting for a host: sign in to Claude Code." }, "a host turned off is not named");
  assert.equal(chiefWaiting(out, ["claude", "codex"], ["claude"]), null, "signed in again: the next duty starts");
  assert.equal(chiefWaiting(`${out}\n## 09:00 — duty: tick\n- status: ok\n- did: triaged\n`, ["claude", "codex"], []), null, "a later run went ahead");
  assert.equal(chiefWaiting(`${out}\n## 08:00 — duty: monitor\n- status: SKIPPED daily-cap\n`, ["claude"], []), null, "capped, not waiting");
  assert.equal(chiefWaiting("## 10:00 — a note\n- status: SKIPPED waiting-for-host\n", ["claude"], []), null, "not a duty entry");
  assert.deepEqual(chiefWaiting("## 10:00 — duty: sitrep\n- status: SKIPPED waiting-for-host\n", ["claude"], []), { kind: "skipped", text: "Your Chief of Staff is waiting for a host: today's duties were skipped." });
  assert.equal(chiefWaiting("", ["claude"], []), null);
  assert.equal(lastWaitingSkip(out), "claude: signed out; codex: CLI not found");
});
