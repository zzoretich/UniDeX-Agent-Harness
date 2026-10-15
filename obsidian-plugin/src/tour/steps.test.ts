import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { BOOK, TOUR_TABS, chapterById, chapterForTab, resolveRefs, stepRef, validateBook } from "./steps";
import { BRAIN_MODES } from "../data/brainModel";

const VIEW = fs.readFileSync(path.join(__dirname, "..", "views", "WorkbenchView.ts"), "utf8");

test("steps.json passes its schema check (tour C5)", () => {
  assert.deepEqual(validateBook(BOOK), []);
});

test("the schema check catches what a hand edit gets wrong", () => {
  const bad = {
    schema: 1, core: "nope",
    chapters: [{
      id: "x", title: "X", summary: "s", tab: "nowhere", steps: [
        { id: "a", anchor: "", title: "T", body: "<b>hi</b>", advance: "hover", since: "2.0" },
        { id: "a", tab: "pulse", mode: "review", anchor: ".x", title: "T", body: "B", advance: "next", when: "sometimes", since: "2.0.0" },
      ],
    }],
    actions: [{ id: "x", title: "T", body: "B", detect: "magic" }],
  };
  const p = validateBook(bad).join("\n");
  for (const want of ["unknown tab nowhere", "no anchor", "holds HTML", "advance must be click or next", "since must be x.y.z", "listed twice",
    "needs tab memory", "unknown predicate sometimes", "core names no chapter", "id is taken", "unknown detector magic"]) {
    assert.ok(p.includes(want), `expected "${want}" in:\n${p}`);
  }
});

test("the tabs a step may route to are exactly the rail's (WorkbenchView RAIL_SECTIONS and Settings)", () => {
  const rail = [...VIEW.matchAll(/\{ id: "([a-z-]+)", icon: "[a-z-]+", label: "[^"]+" \}/g)].map((m) => m[1]);
  assert.deepEqual([...rail].sort(), [...TOUR_TABS].sort());
});

test("a chapter for every surface: each rail tab, each Brain mode, the status bar, capture and search, Help (tour C6)", () => {
  for (const tab of TOUR_TABS) assert.ok(chapterForTab(BOOK, tab), `no chapter for the ${tab} tab`);
  for (const mode of BRAIN_MODES) assert.ok(BOOK.chapters.some((c) => c.tab === "memory" && c.mode === mode), `no chapter for Brain ▸ ${mode}`);
  for (const id of ["status-bar", "capture-search", "help"]) assert.ok(chapterById(BOOK, id), `no ${id} chapter`);
});

test("the welcome tour: about ten steps, rail to Help, routing only by the user's clicks on the rail", () => {
  const core = chapterById(BOOK, BOOK.core);
  assert.ok(core);
  assert.deepEqual(core.steps.map((s) => s.id), ["rail", "pulse", "sessions", "code", "brain", "spaces", "routines", "chief-of-staff", "search", "help"]);
  assert.equal(core.steps.find((s) => s.id === "sessions")?.when, "chatAvailable", "Sessions is off the rail with no host signed in");
  for (const s of core.steps) assert.equal(s.tab, undefined, `${s.id} routes by the click, not by open()`);
  for (const s of core.steps.filter((x) => x.advance === "click")) assert.match(s.anchor, /^\.aos-wb-railbtn\[data-tab="[a-z-]+"\]$/, s.id);
});

test("step text stays generic product copy: no paths, no addresses, only the placeholders the HUD fills", () => {
  for (const c of BOOK.chapters) {
    for (const s of c.steps) {
      const text = `${s.title}\n${s.body}`;
      assert.doesNotMatch(text, /\/Users\/|\/home\/|@[a-z0-9-]+\.[a-z]{2,}/i, stepRef(c.id, s.id));
      for (const m of text.matchAll(/\{([^}]*)\}/g)) assert.match(m[1], /^(host|cmd:[a-z0-9-]+)$/, `${stepRef(c.id, s.id)} has {${m[1]}}`);
    }
  }
});

test("anchors are stable attributes or classes, never positional", () => {
  for (const c of BOOK.chapters) {
    for (const s of c.steps) {
      assert.doesNotMatch(s.anchor, /:nth-|:first-|:last-|>\s*\w+\s*>/, `${stepRef(c.id, s.id)}: ${s.anchor}`);
      assert.match(s.anchor, /\[data-[a-z-]+|\.aos-|#aos-/, `${stepRef(c.id, s.id)}: ${s.anchor}`);
    }
  }
});

test("a step's pane: a Spaces pane on Spaces, History on Sessions (install-import B11), nothing else", () => {
  const book = (tab: string, pane: string) => ({
    schema: 1, core: "c", actions: [],
    chapters: [{ id: "c", title: "C", summary: "s", steps: [{ id: "a", tab, pane, anchor: ".x", title: "T", body: "B", advance: "next", since: "2.0.0" }] }],
  });
  assert.deepEqual(validateBook(book("spaces", "history")), []);
  assert.deepEqual(validateBook(book("chat", "history")), []);
  for (const [tab, pane] of [["chat", "overview"], ["pulse", "history"], ["spaces", "nowhere"]]) {
    assert.match(validateBook(book(tab, pane)).join("\n"), /needs tab spaces and a Spaces pane, or tab chat and history/, `${tab} ${pane}`);
  }
  // Sessions keeps its own chapter for "Tour this tab"; History is a chapter of its own, shown with no host too.
  assert.equal(chapterForTab(BOOK, "chat")?.id, "sessions");
  assert.equal(chapterById(BOOK, "sessions-history")?.when, "sessionsShown");
});

test("Tour this tab picks the Brain mode's chapter when it has one, else the tab's", () => {
  assert.equal(chapterForTab(BOOK, "memory", "health")?.id, "brain-health");
  assert.equal(chapterForTab(BOOK, "memory", null)?.id, "brain");
  assert.equal(chapterForTab(BOOK, "spaces", "health")?.id, "spaces");
  assert.equal(chapterForTab(BOOK, "nowhere"), null);
});

test("a What's new entry's refs resolve to steps: a chapter id is all of it, chapter.step one step", () => {
  const core = chapterById(BOOK, "core")!;
  assert.equal(resolveRefs(BOOK, ["core"]).length, core.steps.length);
  assert.deepEqual(resolveRefs(BOOK, ["pulse.needs", "nope.x", "core.help"]).map((i) => stepRef(i.chapter.id, i.step.id)), ["pulse.needs", "core.help"]);
});
