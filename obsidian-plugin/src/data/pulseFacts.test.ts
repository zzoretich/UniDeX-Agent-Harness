import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "module";
import type { App } from "obsidian";
import { AREAS, gatherPulseInputs, openFlags, pulseFacts, spendToday, type PulseInputs } from "./pulseFacts";
import { diskAdapter } from "./teams";

// The fixture vault is read by both sides (spec 2026-10-08-pulse-cockpit-design P8): this module and
// brain/scripts/lib/pulse-facts.js. Its times carry no offset, so the facts are the same in every timezone.
const REPO = path.resolve(__dirname, "../../..");
const VAULT = path.join(REPO, "brain/scripts/test/fixtures/pulse-vault");
const runtime = createRequire(__filename)(path.join(REPO, "brain/scripts/lib/pulse-facts.js"));
const NOW = new Date(2026, 9, 8, 19, 24);
const withoutHash = ({ hash: _hash, ...rest }: { hash?: string }) => rest;

test("the twin: the same inputs give the runtime's facts (items, order, titles, summary)", () => {
  const inputs = runtime.read(VAULT, { now: NOW }) as PulseInputs;
  assert.deepEqual(pulseFacts(inputs, NOW), withoutHash(runtime.facts(inputs, NOW)));
  assert.deepEqual([...AREAS], runtime.AREAS);
});

test("the HUD's own reads of the fixture vault give the runtime's facts", async () => {
  const app = { vault: { adapter: diskAdapter(VAULT) } } as unknown as App;
  const inputs = await gatherPulseInputs(app, VAULT, NOW);
  assert.deepEqual(pulseFacts(inputs, NOW), withoutHash(runtime.facts(runtime.read(VAULT, { now: NOW }), NOW)));
  assert.equal(inputs.personaName, "Beacon");
  assert.deepEqual(inputs.gates.map((g) => g.item), ["site-02"]);
  // The fixture's hidden entries (_spikes, _archive/old-chart) are left out on both sides (spaces-redesign D22).
  assert.deepEqual(inputs.workspaces, [{ name: "harbor-map", status: "active" }, { name: "field-notes", status: "active" }, { name: "old-site", status: "idle" }]);
  // No brain-hub.json or brain-sources.json there yet: the Brain tile says so rather than 0 (brain-hub D15).
  assert.equal(inputs.toReview, null);
  assert.equal(inputs.brainPct, null);
});

test("the Brain tile's inputs: brain-hub.json's unreviewed count and BRAIN.md's fill from brain-sources.json (brain-hub D15)", async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "pulse-brain-"));
  try {
    fs.mkdirSync(path.join(vault, "brain/_index"), { recursive: true });
    const write = (rel: string, doc: unknown) => fs.writeFileSync(path.join(vault, rel), JSON.stringify(doc));
    write("brain/_index/brain-hub.json", { schema: 1, builtAt: "2026-10-08T07:00:00.000Z", counts: { memories: 12, unreviewed: 7, drafts: 1 }, batches: [] });
    write("brain/_index/brain-sources.json", { schema: 1, builtAt: "2026-10-08T07:00:00.000Z", budget: 850, tokens: 875, sections: {} });
    const app = { vault: { adapter: diskAdapter(vault) } } as unknown as App;
    const inputs = await gatherPulseInputs(app, vault, NOW);
    assert.equal(inputs.toReview, 7);
    assert.equal(inputs.brainPct, 103);
    // The facts never read them: the twin with lib/pulse-facts.js holds with or without.
    assert.deepEqual(pulseFacts(inputs, NOW), pulseFacts({ ...inputs, toReview: null, brainPct: null }, NOW));
    // A cache from another schema, or one that does not parse, is not a count.
    write("brain/_index/brain-hub.json", { schema: 2, counts: { unreviewed: 7 } });
    fs.writeFileSync(path.join(vault, "brain/_index/brain-sources.json"), "{torn");
    const again = await gatherPulseInputs(app, vault, NOW);
    assert.equal(again.toReview, null);
    assert.equal(again.brainPct, null);
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test("today's memories: pending only while live and unreviewed (archive and supersede keep reviewed: false), and to review counts one the hub holds in no batch yet (brain-hub D5, D7, D12)", async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "pulse-retired-"));
  try {
    const mem = (slug: string, tags: string, extra = "") => `---\ntype: memory\ntags: [memory/feedback, ${tags}]\ncreated: 2026-10-08\nreviewed: false\n${extra}---\n\n# ${slug}\n\nBody.\n`;
    const write = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true }); fs.writeFileSync(path.join(vault, rel), text); };
    write("brain/memory/feedback/waits.md", mem("waits", "status/active"));
    write("brain/memory/feedback/after-scan.md", mem("after-scan", "status/active"));
    write("brain/memory/feedback/archived.md", mem("archived", "status/archived", "status_before: active\narchived: 2026-10-08\n"));
    write("brain/memory/feedback/superseded.md", mem("superseded", "status/superseded", "superseded_by: brain/memory/feedback/waits.md\n"));
    const rows = ["waits", "archived", "superseded", "after-scan"].map((slug, i) => JSON.stringify({ ts: `2026-10-08T0${i + 1}:00:00`, action: "written", slug, type: "feedback", title: slug }));
    write("brain/_index/promote-log.jsonl", `${rows.join("\n")}\n`);
    // The scan ran before after-scan.md was written: its batch holds only waits.md.
    write("brain/_index/brain-hub.json", JSON.stringify({ schema: 1, builtAt: "2026-10-08T03:30:00", counts: { unreviewed: 1 }, batches: [{ key: "k", title: "T", at: "2026-10-08T01:00:00", paths: ["brain/memory/feedback/waits.md"] }] }));
    const app = { vault: { adapter: diskAdapter(vault) } } as unknown as App;
    const inputs = await gatherPulseInputs(app, vault, NOW);
    assert.deepEqual(inputs.trail.map((r) => [r.slug, r.pending]), [["waits", true], ["archived", false], ["superseded", false], ["after-scan", true]]);
    assert.equal(inputs.toReview, 2);
    const f = pulseFacts(inputs, NOW);
    assert.deepEqual(f.summary.memory, { writtenToday: 4, pendingReview: 2, drafts: 0 });
    assert.deepEqual(f.needsYou.map((n) => n.title), ["2 memories written today, not yet reviewed"]);
    // The twin reads the same.
    assert.deepEqual(f, withoutHash(runtime.facts(runtime.read(vault, { now: NOW }), NOW)));
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test("an empty vault: no items, nothing thrown", async () => {
  const f = pulseFacts({ personaName: null, proposals: [], stateMd: null, drafts: 0, gates: [], issues: [], workspaces: [], pipelines: {}, routines: {}, todo: null, notifications: [], trail: [], spend: { usd: 0, calls: 0 }, toReview: null, brainPct: null }, NOW);
  assert.deepEqual(f.needsYou, []);
  assert.equal(f.summary.notifications.latest, null);
});

test("open flags: unchecked and bare bullets under ## Flags only, with a leading date split off", () => {
  assert.deepEqual(openFlags("## Flags\n- [ ] 2026-10-01 One\n- [x] Done\n- (none)\n* Two\n## Next\n- Not a flag"), [
    { date: "2026-10-01", text: "One" }, { date: null, text: "Two" },
  ]);
});

test("spend today: the local day's rows, every row a call, usd summed", () => {
  const text = ['{"ts":"2026-10-07T23:00:00","usd":1}', '{"ts":"2026-10-08T07:00:00","usd":0.25}', '{"ts":"2026-10-08T08:00:00"}', "torn"].join("\n");
  assert.deepEqual(spendToday(text, NOW), { usd: 0.25, calls: 2 });
});
