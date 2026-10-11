import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { AREA_LABEL, AREA_TAB, BRIEFING_ROUTINE, bandLabels, brainLinks, brainReviewLabel, brainTodayLabel, touchesPulse } from "./meta";

const REPO = path.resolve(__dirname, "../../../..");

test("'Turn on' writes exactly the routine new vaults get (vault-template/brain/routines/briefing.md)", () => {
  assert.equal(BRIEFING_ROUTINE, fs.readFileSync(path.join(REPO, "vault-template/brain/routines/briefing.md"), "utf8"));
});

test("Pulse redraws for its facts, caches and the briefing, and not for unrelated files", () => {
  for (const p of ["brain/_index/briefing.json", "brain/_index/snapshot.json", "persona/proposals/x.md", "persona/STATE.md", "TODO.md",
    "brain/notifications/2026/x.md", "brain/memory/feedback/_drafts/a.md", "brain/routines/briefing.md", "persona/teams/lab/board.jsonl",
    "brain/_index/brain-hub.json", "brain/_index/brain-sources.json"]) {
    assert.ok(touchesPulse(p), p);
  }
  for (const p of ["notes/x.md", "brain/_index/recall-index.json", "workspaces/a/README.md"]) assert.ok(!touchesPulse(p), p);
});

test("the band's buttons say what they do; two that would read alike name their items", () => {
  const item = (kind: string, title: string, ref = "") => ({ kind, title, ref });
  assert.deepEqual(bandLabels([{ n: item("error", "hooks point nowhere"), label: "Fix in a session →", jump: true }, { n: item("proposal", "Trim the playbook"), label: "Review →", jump: true }]),
    ["See the error →", "Review the proposal →"]);
  assert.deepEqual(bandLabels([{ n: item("routine", "x", "nightly-scan"), label: "Run now", jump: false }, { n: item("pipeline", "x", "embed"), label: "See →", jump: true }]),
    ["Run nightly-scan", "See embed →"]);
  assert.deepEqual(bandLabels([{ n: item("proposal", "Trim the playbook"), label: "Review →", jump: true }, { n: item("proposal", "An idea with loose ends that runs long"), label: "Review →", jump: true }]),
    ["Review “Trim the playbook” →", "Review “An idea with loose ends…” →"]);
  assert.deepEqual(bandLabels([{ n: item("proposal", "Trim the playbook"), label: "Review →", jump: true }]), ["Review the proposal →"]);
});

test("the review and drafts items jump into the Brain tab, and the band says so (brain-hub D15)", () => {
  const item = (kind: string, title: string) => ({ kind, title, ref: kind });
  assert.deepEqual(bandLabels([{ n: item("drafts", "1 feedback draft waiting for review"), label: "Review →", jump: true }, { n: item("review", "2 memories written today, not yet reviewed"), label: "Review →", jump: true }]),
    ["Review the drafts →", "Review the memories →"]);
});

test("the Brain area: labelled Brain, still the rail's memory tab (brain-hub D16)", () => {
  assert.equal(AREA_LABEL.memory, "Brain");
  assert.equal(AREA_TAB.memory, "memory");
});

test("the Brain tile's three numbers: each lands on its mode; colour only for state; a missing cache reads —", () => {
  const links = brainLinks({ toReview: 257, drafts: 20, brainPct: 103 });
  assert.deepEqual(links.map((l) => [l.id, l.value, l.label, l.tone]), [["review", "257", "to review", "warn"], ["drafts", "20", "drafts", "gate"], ["bootstrap", "103%", "BRAIN.md", "warn"]]);
  assert.deepEqual(links.map((l) => l.target), [{ mode: "review", queue: "session" }, { mode: "review", queue: "drafts" }, { mode: "bootstrap" }]);
  assert.deepEqual(links.map((l) => l.row), ["257 to review", "20 feedback drafts", "BRAIN.md 103% of its budget"]);
  assert.deepEqual(links.map((l) => l.act), ["Review →", "Review →", "Open →"]);
  assert.deepEqual(links.map((l) => l.meta), ["unreviewed memories by session · Brain › Review", "brain/memory/feedback/_drafts · Brain › Review › Drafts", "what every session starts with · Brain › Bootstrap"]);
  const quiet = brainLinks({ toReview: 0, drafts: 1, brainPct: 99 });
  assert.deepEqual(quiet.map((l) => [l.value, l.label, l.tone]), [["0", "to review", "off"], ["1", "draft", "gate"], ["99%", "BRAIN.md", "off"]]);
  assert.equal(quiet[1].row, "1 feedback draft");
  const none = brainLinks({ toReview: null, drafts: 0, brainPct: null });
  assert.deepEqual(none.map((l) => [l.value, l.tone]), [["—", "off"], ["0", "off"], ["—", "off"]]);
  assert.deepEqual(none.map((l) => l.row), ["Memories to review: counted at the next scan", "0 feedback drafts", "BRAIN.md: measured at its next build"]);
});

test("the Brain tile's words: today and since you looked; Review today's, or Review itself when none of today's waits", () => {
  assert.equal(brainTodayLabel(6), "today · 6 since you looked");
  assert.equal(brainReviewLabel(6), "Review today’s 6 in Brain →");
  assert.equal(brainReviewLabel(0), "Open Review in Brain →");
});
