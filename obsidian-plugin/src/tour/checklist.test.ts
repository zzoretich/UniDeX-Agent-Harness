import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  MEMORY_TRAIL, PERSONA_IDENTITY, ROUTINES_FOLDER, RUNS_LOG, SEEDED_ROUTINES, buildChecklist, detectDone, hasOwnRoutine, hasReview, hasSession,
  type CacheReader,
} from "./checklist";
import { BOOK } from "./steps";
import { DEFAULT_TOUR_STATE, markCompleted, markDone, setChecklistDismissed } from "./state";
import { RUNS_PATH } from "../data/runs";
import { TRAIL_PATH } from "../data/promoteTrail";
import { ROUTINES_DIR } from "../data/routines";
import { PERSONA_IDENTITY_PATH } from "../data/aosConfig";
import type { TourContext } from "./predicates";

const CLAUDE: TourContext = { hosts: ["claude"], chat: false, checklist: true };
const CODEX: TourContext = { hosts: ["codex"], chat: true, checklist: true };
const NONE: TourContext = { hosts: [], chat: false, checklist: true };

test("the caches it reads are the ones the HUD already reads", () => {
  assert.deepEqual([RUNS_LOG, MEMORY_TRAIL, ROUTINES_FOLDER, PERSONA_IDENTITY], [RUNS_PATH, TRAIL_PATH, ROUTINES_DIR, PERSONA_IDENTITY_PATH]);
});

test("the seeded routines are the vault template's", () => {
  const dir = path.join(__dirname, "..", "..", "..", "vault-template", "brain", "routines");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort();
  assert.deepEqual(files, [...SEEDED_ROUTINES].sort());
});

test("the welcome tour first, then each chapter this Mac can show, then the actions (tour C9)", () => {
  const list = buildChecklist(BOOK, DEFAULT_TOUR_STATE, CLAUDE);
  assert.equal(list.items[0].id, "core");
  assert.equal(list.items[0].title, "Take the welcome tour");
  assert.ok(!list.items.some((i) => i.id === "sessions"), "Sessions is gated by chatAvailable");
  assert.ok(buildChecklist(BOOK, DEFAULT_TOUR_STATE, CODEX).items.some((i) => i.id === "sessions"));
  const kinds = list.items.map((i) => i.kind);
  assert.equal(kinds.indexOf("action"), kinds.lastIndexOf("chapter") + 1, "chapters, then actions");
  assert.deepEqual([list.done, list.shown], [0, true]);
  assert.ok(!buildChecklist(BOOK, DEFAULT_TOUR_STATE, NONE).items.some((i) => i.id === "first-session"), "no host: no session to run");
});

test("done counts completed chapters and seen actions; it leaves the rail when put away or finished", () => {
  let s = markCompleted(DEFAULT_TOUR_STATE, "core");
  s = markDone(s, ["first-review"], new Date());
  const list = buildChecklist(BOOK, s, CLAUDE);
  assert.equal(list.done, 2);
  assert.ok(list.items.find((i) => i.id === "core")?.done && list.items.find((i) => i.id === "first-review")?.done);
  assert.equal(buildChecklist(BOOK, setChecklistDismissed(s, true), CLAUDE).shown, false);
  let all = DEFAULT_TOUR_STATE;
  for (const it of list.items) all = it.kind === "chapter" ? markCompleted(all, it.id) : markDone(all, [it.id], new Date());
  const finished = buildChecklist(BOOK, all, CLAUDE);
  assert.deepEqual([finished.done, finished.shown], [finished.total, false]);
});

test("detectors read caches only: a session row, a review verb, a routine of your own, a persona", () => {
  assert.equal(hasSession(null), false);
  assert.equal(hasSession('{"id":"r1","script":"scan-vault"}\nnot json\n'), false);
  assert.equal(hasSession('{"id":"sess-abc","script":"session"}'), true);
  assert.equal(hasSession('{"id":"sess-abc-s2"}'), true);
  assert.equal(hasReview('{"action":"written","slug":"a"}'), false);
  assert.equal(hasReview('{"action":"written"}\n{"action":"kept","slug":"a"}'), true);
  assert.equal(hasOwnRoutine(["brain/routines/README.md", "brain/routines/briefing.md", "brain/routines/import-digest.md", "brain/routines/sitrep.md"]), false);
  assert.equal(hasOwnRoutine(["brain/routines/monitor.md", "brain/routines/standup-notes.md"]), true);
});

test("detectDone ticks what the caches show and skips what is already ticked", async () => {
  const files: Record<string, string> = {
    [RUNS_LOG]: '{"id":"sess-1","script":"session"}\n',
    [PERSONA_IDENTITY]: "# Chief\n",
  };
  const reads: string[] = [];
  const reader: CacheReader = {
    read: async (p) => { reads.push(p); return files[p] ?? null; },
    list: async () => ["brain/routines/briefing.md"],
  };
  assert.deepEqual(await detectDone(BOOK.actions, DEFAULT_TOUR_STATE, reader), ["first-session", "chief-set-up"]);
  reads.length = 0;
  const ticked = markDone(DEFAULT_TOUR_STATE, ["first-session"], new Date());
  assert.deepEqual(await detectDone(BOOK.actions, ticked, reader), ["chief-set-up"]);
  assert.ok(!reads.includes(RUNS_LOG), "a ticked action is not read again");
  const broken: CacheReader = { read: async () => { throw new Error("EACCES"); }, list: async () => { throw new Error("EACCES"); } };
  assert.deepEqual(await detectDone(BOOK.actions, DEFAULT_TOUR_STATE, broken), []);
});
