import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { createRequire } from "module";
import { chooseParagraph, fineOf, mentionParts, parseBriefing, sayOf, sinceLine, templateParagraph } from "./briefingBand";
import { pulseFacts, EMPTY_INPUTS, type PulseInputs } from "./pulseFacts";

const REPO = path.resolve(__dirname, "../../..");
const VAULT = path.join(REPO, "brain/scripts/test/fixtures/pulse-vault");
const req = createRequire(__filename);
const runtime = req(path.join(REPO, "brain/scripts/lib/pulse-facts.js"));
const writer = req(path.join(REPO, "brain/scripts/persona/briefing.js"));
const NOW = new Date(2026, 9, 8, 19, 24);
const inputs = runtime.read(VAULT, { now: NOW }) as PulseInputs;
const facts = pulseFacts(inputs, NOW);

test("the words for items and what is fine match the writer's (brain/scripts/persona/briefing.js)", () => {
  for (const n of facts.needsYou) assert.equal(sayOf(n), writer.sayOf(n), n.title);
  const quiet = pulseFacts({ ...EMPTY_INPUTS, routines: { a: { failStreak: 0 } }, todo: "- [ ] x", spend: { usd: 1.5, calls: 3 } }, NOW);
  assert.deepEqual(fineOf(quiet.summary).map((m) => ({ say: m.phrase, area: m.area })), writer.fineOf(quiet.summary));
});

test("the composed paragraph: the first item and its wait, two more, the rest as a count; each mention is a span of it", () => {
  const t = templateParagraph(facts, NOW);
  assert.equal(t.text, "Good evening. 2 hook references in settings.json point to non-existent files. Also the “Tidy the memory index” proposal, Duty writes denied in unattended runs, and 12 more. $0.41 spent today.");
  assert.deepEqual(t.mentions, [
    { phrase: "2 hook references in settings.json point to non-existent files", area: "health" },
    { phrase: "the “Tidy the memory index” proposal", area: "proposals" },
    { phrase: "Duty writes denied in unattended runs", area: "proposals" },
    { phrase: "12 more", area: "needs" },
    { phrase: "$0.41 spent today", area: "spend" },
  ]);
  for (const m of t.mentions) assert.ok(t.text.includes(m.phrase), m.phrase);
});

test("a quiet vault: nothing needs you, then what is fine", () => {
  const quiet = pulseFacts({ ...EMPTY_INPUTS, routines: { a: { failStreak: 0 }, b: { failStreak: 0 } }, spend: { usd: 0.4, calls: 2 } }, new Date(2026, 9, 8, 9, 0));
  assert.equal(templateParagraph(quiet, new Date(2026, 9, 8, 9, 0)).text, "Good morning. Nothing needs you right now. 2 routines green and $0.40 spent today.");
});

test("the model's paragraph while ok and fresh; the composed one when missing, failed, skipped or stale", () => {
  const ok = parseBriefing(JSON.stringify({ schema: 1, status: "ok", text: "Hi.", mentions: [{ phrase: "Hi", area: "needs" }, { phrase: "x", area: "nowhere" }], generatedAt: new Date(NOW.getTime() - 3600_000).toISOString() }));
  assert.deepEqual(ok!.mentions, [{ phrase: "Hi", area: "needs" }]);
  const p = chooseParagraph(ok, facts, NOW, 3);
  assert.equal(p.source, "model");
  assert.equal(p.text, "Hi.");
  assert.equal(chooseParagraph(ok, facts, NOW, 0.5).source, "template");
  assert.equal(chooseParagraph(null, facts, NOW, 3).reason, "not written yet");
  const failed = parseBriefing(JSON.stringify({ schema: 1, status: "failed", reason: "timeout", text: "Old.", generatedAt: NOW.toISOString() }));
  assert.deepEqual([chooseParagraph(failed, facts, NOW, 3).source, chooseParagraph(failed, facts, NOW, 3).reason], ["template", "last run failed"]);
  const skipped = parseBriefing(JSON.stringify({ schema: 1, status: "skipped", reason: "daily-cap", generatedAt: null }));
  assert.equal(chooseParagraph(skipped, facts, NOW, 3).reason, "daily-cap");
  assert.equal(parseBriefing("{"), null);
  assert.equal(parseBriefing(JSON.stringify({ schema: 2 })), null);
});

test("mention parts: plain and mention runs in order, any case, each at its first free place", () => {
  assert.deepEqual(mentionParts("Good evening. The Weekly digest proposal waits; 3 more.", [{ phrase: "3 more", area: "needs" }, { phrase: "the weekly digest proposal", area: "proposals" }]), [
    { text: "Good evening. ", area: null },
    { text: "The Weekly digest proposal", area: "proposals" },
    { text: " waits; ", area: null },
    { text: "3 more", area: "needs" },
    { text: ".", area: null },
  ]);
  assert.deepEqual(mentionParts("plain", [{ phrase: "absent", area: "todo" }]), [{ text: "plain", area: null }]);
  // Any quote style finds a quoted title, and the run keeps the text's own quotes.
  assert.deepEqual(mentionParts('The "Weekly digest" proposal waits.', [{ phrase: "the “Weekly digest” proposal", area: "proposals" }]), [
    { text: 'The "Weekly digest" proposal', area: "proposals" },
    { text: " waits.", area: null },
  ]);
});

test("since you last looked: notifications, memories, decisions and failed routines after the last visit", () => {
  assert.equal(sinceLine(inputs, null, NOW), null);
  assert.deepEqual(sinceLine(inputs, "2026-10-08T12:02:00", NOW)!.parts, ["+2 notifications", "+1 memory"]);
  assert.deepEqual(sinceLine(inputs, "2026-10-08T07:00:00", NOW)!.parts, ["+3 notifications", "+2 memories", "1 routine failed"]);
  assert.deepEqual(sinceLine(inputs, "2026-10-08T19:20:00", NOW)!.parts, ["nothing new"]);
});
