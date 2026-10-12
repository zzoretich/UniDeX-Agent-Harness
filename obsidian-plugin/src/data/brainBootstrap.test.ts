import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BULLET_DESC_CHARS, SHIPPED, activeHeader, bootstrapSections, brainBullet, budgetBars, clampToChars, completeAllLabel,
  completeConfirm, eachUntilFailure, hasPromoteTag, hitAge, indexCard, indexEntries, openablePath, recallRows, reviewShippedLabel,
  scoreText, sessionCard, shippedLede, shippedSummary, shippedWhy, wakeHits, wrapNote, type BootstrapInput,
} from "./brainBootstrap";
import { estimateTokens, indexLineCount, parseBrainHub, parseBrainSources, parseIndexLines, parseMemory, parseNote, type BrainMemory } from "./brainModel";

const P = (type: string, slug: string): string => `brain/memory/${type}/${slug}.md`;

const mem = (type: string, slug: string, o: { title?: string; tags?: string; pin?: boolean; description?: string; body?: string } = {}): string =>
  ["---", "type: memory", `tags: [memory/${type}${o.tags ? `, ${o.tags}` : ""}]`, "created: 2026-10-01", "updated: 2026-10-01",
    ...(o.pin ? ["pin: true"] : []), ...(o.description ? [`description: ${o.description}`] : []), "---", "",
    `# ${o.title ?? slug}`, "", o.body ?? `The body of ${slug}.`, ""].join("\n");

const sources = (o: { tokens?: number; budget?: number; who?: string[]; rules?: string[]; active?: string[]; omitted?: string[]; sec?: Partial<Record<string, number>> } = {}): string =>
  JSON.stringify({
    schema: 1, builtAt: "2026-10-11T12:00:00.000Z", budget: o.budget ?? 850, tokens: o.tokens ?? 600,
    sections: {
      who: { paths: o.who ?? [], tokens: o.sec?.who ?? 40 },
      rules: { paths: o.rules ?? [], tokens: o.sec?.rules ?? 30 },
      active: { paths: o.active ?? [], omitted: o.omitted ?? [], tokens: o.sec?.active ?? 200 },
      links: { tokens: o.sec?.links ?? 53 },
      lastSession: { tokens: o.sec?.lastSession ?? 35, clampedChars: 0 },
    },
  });

/** A small store: a profile, two pinned rules (one since unpinned, one archived), active projects (some look shipped). */
function fixture(): BootstrapInput & { memories: BrainMemory[] } {
  const indexRaw = [
    "# Memory index", "",
    "## User", `- [Profile](${P("user", "profile")}) — who the owner is`, "",
    "## Feedback",
    `- [Search the graph first](${P("feedback", "graph-first")}) — use the graph tools before reading files`,
    `- [Old rule](${P("feedback", "old-rule")}) — a rule that was unpinned since`,
    `- [Gone rule](${P("feedback", "gone-rule")}) — archived since`, "",
    "## Projects",
    `- [Widget 1.5.0 release](${P("projects", "widget-release")}) — the cockpit went out to everyone`,
    `- [Brain hub redesign](${P("projects", "brain-hub")}) — merged in PR 121, more to come`,
    `- [Ledger tool](${P("projects", "ledger")}) — ${"a long description that runs past the seventy-two characters BRAIN.md keeps per line"}`,
    `- [Old proposal (superseded)](${P("projects", "old-proposal")}) — replaced by a newer plan`,
    `- [Rail sections](${P("projects", "rail")}) — the rail grew three sections`,
    `- [Done thing](${P("projects", "done-thing")}) — shipped and marked complete since`,
    "",
  ].join("\n");
  const files: Record<string, string> = {
    [P("user", "profile")]: mem("user", "profile", { title: "Profile", body: "The owner builds tools.\nThey like short answers.\n\nSecond paragraph." }),
    [P("feedback", "graph-first")]: mem("feedback", "graph-first", { title: "Search the graph first", pin: true, tags: "status/active" }),
    [P("feedback", "old-rule")]: mem("feedback", "old-rule", { title: "Old rule", tags: "status/active" }),
    [P("feedback", "gone-rule")]: mem("feedback", "gone-rule", { title: "Gone rule", pin: true, tags: "status/archived" }),
    [P("projects", "widget-release")]: mem("projects", "widget-release", { title: "Widget 1.5.0 release", tags: "status/active" }),
    [P("projects", "brain-hub")]: mem("projects", "brain-hub", { title: "Brain hub redesign", tags: "status/active" }),
    [P("projects", "ledger")]: mem("projects", "ledger", { title: "Ledger tool", tags: "status/active", description: "Released to the team last week" }),
    [P("projects", "old-proposal")]: mem("projects", "old-proposal", { title: "Old proposal (superseded)", tags: "status/active" }),
    [P("projects", "rail")]: mem("projects", "rail", { title: "Rail sections", tags: "status/active" }),
    [P("projects", "done-thing")]: mem("projects", "done-thing", { title: "Done thing", tags: "status/complete" }),
  };
  const index = parseIndexLines(indexRaw);
  const memories = Object.entries(files).map(([p, t]) => parseMemory(p, t, index)).filter((m): m is BrainMemory => !!m);
  return {
    memories, byPath: new Map(memories.map((m) => [m.path, m])), index, indexRaw, hub: null, session: null, wake: null,
    sources: parseBrainSources(sources({
      who: [P("user", "profile")],
      rules: [P("feedback", "graph-first"), P("feedback", "old-rule"), P("feedback", "gone-rule")],
      active: [P("projects", "widget-release"), P("projects", "brain-hub"), P("projects", "ledger"), P("projects", "done-thing")],
      omitted: [P("projects", "old-proposal"), P("projects", "rail"), P("projects", "missing")],
    })),
  };
}

// ── a line of BRAIN.md ──

test("clampToChars cuts as build-brain-md.js does: at a word break past 60%, else mid-word, with an ellipsis", () => {
  assert.equal(clampToChars("short", 72), "short");
  assert.equal(clampToChars("x".repeat(72), 72), "x".repeat(72));
  assert.equal(clampToChars("aaaa bbbb cccc dddd", 12), "aaaa bbbb…");
  assert.equal(clampToChars("aaaaaaaaaaaaaaaaaaaa", 10), "aaaaaaaaa…");
  // A word break before 60% of the room is not used: the cut is mid-word.
  assert.equal(clampToChars("ab cdefghijklmnop", 10), "ab cdefgh…");
});

test("indexEntries reads MEMORY.md as build-brain-md.js parseMemoryIndex does: title, description, a later line wins", () => {
  const raw = [`- [First](${P("projects", "a")}) — one`, `- [Second](${P("projects", "a")}) — two  `, "- [No dash](brain/memory/projects/b.md)", `-   [Spaced]( ${P("user", "c")} ) —  three`].join("\r\n");
  const e = indexEntries(raw);
  assert.deepEqual(e.get(P("projects", "a")), { title: "Second", description: "two" });
  assert.equal(e.has(P("projects", "b")), false, "a line with no description is not an entry (BRAIN.md says no MEMORY.md entry)");
  assert.deepEqual(e.get(P("user", "c")), { title: "Spaced", description: "three" });
  assert.equal(indexEntries(null).size, 0);
});

test("brainBullet is BRAIN.md's line: the index title in bold, the description cut to 72; no entry says so", () => {
  const e = indexEntries(`- [Ledger](${P("projects", "ledger")}) — ${"word ".repeat(30).trim()}`);
  const line = brainBullet(P("projects", "ledger"), e);
  assert.match(line, /^- \*\*Ledger\*\* — word word/);
  assert.ok(line.length <= "- **Ledger** — ".length + BULLET_DESC_CHARS);
  assert.ok(line.endsWith("…"));
  assert.equal(brainBullet(P("projects", "nope"), e), "- **nope** — (no MEMORY.md entry)");
});

// ── looks shipped (D17) ──

test("SHIPPED: a full x.y.z, shipped, released or superseded; never merged, a bare x.y, or release", () => {
  assert.equal(shippedWhy("Brain hub redesign", "merged in PR 121, more to come"), null);
  assert.equal(shippedWhy("Widget 1.5.0 release", null), "1.5.0");
  assert.equal(shippedWhy("Old proposal (superseded)", ""), "superseded");
  assert.equal(shippedWhy("Ledger tool", "Released to the team last week"), "Released");
  assert.equal(shippedWhy("Cut the release", "plan the next release"), null);
  assert.equal(shippedWhy("Engine v2.1 plan", null), null);
  assert.equal(shippedWhy("Engine v2.1.3", null), "v2.1.3");
  assert.equal(shippedWhy("Tooling", "it shipped on Friday"), "shipped");
  assert.equal(shippedWhy("Unshipped ideas", "unreleased"), null);
  assert.ok(SHIPPED.test("SHIPPED"));
  // An address is not a version (brain-hub.js SHIPPED is the twin); a version that ends a sentence still is.
  assert.equal(shippedWhy("Local model", "Ollama at 127.0.0.1:11434"), null);
  assert.equal(shippedWhy("Survey box", "server 192.168.1.20"), null);
  assert.equal(shippedWhy("Tagged v1.2.0.", null), "v1.2.0");
});

// ── BRAIN.md by section ──

test("bootstrapSections: null before build-brain-md records its sources", () => {
  const f = fixture();
  assert.equal(bootstrapSections({ ...f, sources: null }), null);
});

test("bootstrapSections: rules the files still pin, projects the files still call active, titles and lines from MEMORY.md", () => {
  const f = fixture();
  const s = bootstrapSections(f)!;
  assert.equal(s.who.row?.path, P("user", "profile"));
  assert.equal(s.who.row?.line, "The owner builds tools. They like short answers.");
  assert.equal(s.who.tokens, 40);
  // Unpinned since the build, and archived since: neither is offered Unpin.
  assert.deepEqual(s.rules.rows.map((r) => r.path), [P("feedback", "graph-first")]);
  const rule = s.rules.rows[0];
  assert.equal(rule.title, "Search the graph first");
  assert.equal(rule.line, "- **Search the graph first** — use the graph tools before reading files");
  assert.equal(rule.tokens, estimateTokens(`${rule.line}\n`));
  assert.equal(rule.shipped, null, "only Active context is checked for looking shipped");
  assert.equal(rule.memory.hash, f.byPath.get(P("feedback", "graph-first"))!.hash, "the hash `set --expect` takes is the file's as read");
  // Complete since the build: dropped; a path with no file: dropped. Order is the build's (newest first).
  assert.deepEqual(s.active.shown.map((r) => r.path), [P("projects", "widget-release"), P("projects", "brain-hub"), P("projects", "ledger")]);
  assert.deepEqual(s.active.leftOut.map((r) => r.path), [P("projects", "old-proposal"), P("projects", "rail")]);
  assert.equal(s.active.shownCount, 4, "the counts are BRAIN.md's as built");
  assert.equal(s.active.leftOutCount, 3);
  const ledger = s.active.shown[2];
  assert.ok(ledger.description.endsWith("…") && ledger.description.length <= BULLET_DESC_CHARS);
  assert.deepEqual(s.active.shown.map((r) => r.shipped), ["1.5.0", null, "Released"], "the memory's own description counts (brain-hub.js)");
  assert.deepEqual(s.active.leftOut.map((r) => r.shipped), ["superseded", null]);
  assert.deepEqual([s.links.tokens, s.lastSession.tokens, s.rules.tokens, s.active.tokens], [53, 35, 30, 200]);
});

test("bootstrapSections: `keep` hides rows whose verb runs; an index title wins over the H1; no profile, no Who row", () => {
  const f = fixture();
  const s = bootstrapSections(f, (p) => p !== P("projects", "brain-hub"))!;
  assert.deepEqual(s.active.shown.map((r) => r.path), [P("projects", "widget-release"), P("projects", "ledger")]);
  // A pinned project shows in both sections: Unpin running hides its rule row only, not its Active context row.
  const both = parseMemory(P("projects", "rail"), mem("projects", "rail", { title: "Rail sections", tags: "status/active", pin: true }))!;
  const byPath = new Map(f.byPath).set(both.path, both);
  const src = parseBrainSources(sources({ rules: [both.path], active: [both.path] }));
  const x = bootstrapSections({ ...f, byPath, sources: src }, (p, sec) => !(sec === "rules" && p === both.path))!;
  assert.deepEqual([x.rules.rows.length, x.active.shown.map((r) => r.path)], [0, [both.path]]);
  const noIndex = bootstrapSections({ ...f, indexRaw: "" })!;
  assert.equal(noIndex.rules.rows[0].title, "Search the graph first", "the H1 when MEMORY.md has no line");
  assert.equal(noIndex.rules.rows[0].line, "- **graph-first** — (no MEMORY.md entry)");
  const noWho = bootstrapSections({ ...f, sources: parseBrainSources(sources({ who: [] })) })!;
  assert.equal(noWho.who.row, null);
  assert.deepEqual(noWho.rules.rows, []);
});

test("shippedSummary and the lede: N of the M active projects, what their BRAIN.md lines free, then the left-out ones", () => {
  const s = bootstrapSections(fixture())!;
  const x = shippedSummary(s);
  assert.deepEqual(x.rows.map((r) => r.path), [P("projects", "widget-release"), P("projects", "ledger"), P("projects", "old-proposal")]);
  assert.equal(x.of, 5);
  assert.equal(x.inBrain, 2);
  const chars = s.active.shown.filter((r) => r.shipped).reduce((n, r) => n + r.line.length + 1, 0);
  assert.equal(x.tokens, Math.ceil(chars / 4));
  assert.equal(shippedLede(x), `3 of the 5 active projects look shipped. Marking them complete frees about ${x.tokens} tokens of BRAIN.md for work that is live.`);
  assert.equal(reviewShippedLabel(3), "Review the 3…");
  assert.equal(completeAllLabel(3), "Mark the 3 complete…");
  assert.equal(shippedLede({ rows: [], of: 4, inBrain: 0, tokens: 0 }), null);
  assert.equal(shippedLede({ rows: [s.active.leftOut[0]], of: 1, inBrain: 0, tokens: 0 }), "1 of the 1 active project looks shipped. It does not fit in BRAIN.md now; marking it complete takes it off the active list.");
  // Several, none of them in BRAIN.md: no double negative.
  assert.equal(shippedLede({ rows: [s.active.leftOut[0], s.active.leftOut[0]], of: 5, inBrain: 0, tokens: 0 }), "2 of the 5 active projects look shipped. None of them fits in BRAIN.md now; marking them complete takes them off the active list.");
  assert.equal(shippedLede({ rows: [s.active.shown[0]], of: 2, inBrain: 1, tokens: 1 }), "1 of the 2 active projects looks shipped. Marking it complete frees about 1 token of BRAIN.md for work that is live.");
  assert.equal(reviewShippedLabel(1), "Review it…");
  assert.equal(completeAllLabel(1), "Mark it complete…");
});

test("activeHeader: the section's tokens and counts, the left-out count on its own (it is coloured, with its words)", () => {
  const s = bootstrapSections(fixture())!;
  assert.deepEqual(activeHeader(s.active), { text: "200 tokens · 4 shown", leftOut: "3 left out" });
  assert.deepEqual(activeHeader({ ...s.active, leftOutCount: 0, tokens: 1 }), { text: "1 token · 4 shown", leftOut: null });
});

test("completeConfirm names what it marks: up to four by title, else three and a count; one reads singular", () => {
  const t = (title: string) => ({ title });
  const four = completeConfirm([t("A"), t("B"), t("C"), t("D")]);
  assert.equal(four.title, "Mark 4 projects complete?");
  assert.match(four.message, /^Sets status\/complete on “A”, “B”, “C” and “D”\. They leave Active context and BRAIN\.md is rebuilt\. Nothing is archived or deleted/);
  assert.equal(four.label, "Mark 4 complete");
  assert.match(completeConfirm([t("A"), t("B"), t("C"), t("D"), t("E"), t("F")]).message, /“A”, “B”, “C” and 3 more\./);
  const one = completeConfirm([t("Solo")]);
  assert.equal(one.title, "Mark “Solo” complete?");
  assert.match(one.message, /^Sets status\/complete on “Solo”\. It leaves Active context/);
  assert.equal(one.label, "Mark complete");
});

test("eachUntilFailure runs in order and stops at the first failure or throw (the bulk Mark complete)", async () => {
  const seen: string[] = [];
  const ok = await eachUntilFailure(["a", "b", "c"], async (x) => { seen.push(x); return { ok: true }; });
  assert.deepEqual(ok, { done: 3, failed: null, at: null });
  seen.length = 0;
  const stop = await eachUntilFailure(["a", "b", "c"], async (x) => { seen.push(x); return x === "b" ? { ok: false, reason: "a.md changed since it was read" } : { ok: true }; });
  assert.deepEqual(stop, { done: 1, failed: "a.md changed since it was read", at: "b" });
  assert.deepEqual(seen, ["a", "b"], "nothing runs after the failure");
  const threw = await eachUntilFailure(["a", "b"], async (x) => { if (x === "a") throw new Error("boom"); return { ok: true }; });
  assert.deepEqual(threw, { done: 0, failed: "boom", at: "a" });
  assert.deepEqual(await eachUntilFailure([], async () => ({ ok: true })), { done: 0, failed: null, at: null });
  assert.equal((await eachUntilFailure(["a"], async () => ({ ok: false }))).failed, "it did not go through");
});

// ── the budget bars ──

const WAKE = [
  "<!-- generated by brain/scripts/sdk/lib/recall.js at SessionEnd — auto-recall, hard cap 3 snippets -->",
  "## Recall (auto)",
  "- `brain/memory/projects/widget-release.md` (4d) — The cockpit went out to everyone…",
  "- `brain/patterns/release-steps.md` (stale: 75d) — Tag, build, notarize…",
  "",
].join("\n");

test("wakeHits reads recall-wake.md's lines as writeWakeRecall writes them", () => {
  assert.deepEqual(wakeHits(WAKE), [{ path: "brain/memory/projects/widget-release.md", flag: "4d" }, { path: "brain/patterns/release-steps.md", flag: "stale: 75d" }]);
  assert.deepEqual(wakeHits(null), []);
  assert.deepEqual(wakeHits("## Recall (auto)\n"), []);
});

test("budgetBars: BRAIN.md against its budget, full when projects are left out, over when past it; none yet without sources", () => {
  const none = budgetBars({ sources: null, session: null, wake: null });
  assert.deepEqual(none.map((b) => b.key), ["brain", "session", "wake"]);
  assert.equal(none[0].known, false);
  assert.equal(none[0].value, "not built yet");
  assert.equal(none[1].known, false);
  assert.equal(none[2].value, "no hits");
  assert.equal(none[2].known, true, "no recall-wake.md is a real zero of three");
  assert.equal(none[2].pct, 0);

  const free = budgetBars({ sources: parseBrainSources(sources({ tokens: 600 })), session: null, wake: null })[0];
  assert.deepEqual([free.value, free.now, free.max, free.pct, free.warn, free.note], ["600 / 850 tokens", 600, 850, 71, false, "250 tokens free"]);
  const full = budgetBars({ sources: parseBrainSources(sources({ tokens: 847, omitted: [P("projects", "a"), P("projects", "b")] })), session: null, wake: null })[0];
  assert.equal(full.warn, true);
  assert.equal(full.note, "Full: 2 older active projects left out");
  const over = budgetBars({ sources: parseBrainSources(sources({ tokens: 875 })), session: null, wake: null })[0];
  assert.deepEqual([over.pct, over.warn, over.note], [100, true, "Over budget by 25 tokens"]);
});

test("budgetBars: SESSION.md's tokens over 400, recall-wake.md's hits over 3 and its tokens", () => {
  const [, s, w] = budgetBars({ sources: null, session: "x".repeat(380 * 4), wake: WAKE });
  assert.deepEqual([s.value, s.pct, s.warn, s.note], ["380 / 400 tokens", 95, false, "Working memory, reset at each wrap"]);
  assert.deepEqual([w.value, w.now, w.max, w.pct, w.warn], [`2 of 3 hits · ${estimateTokens(WAKE)} tokens`, 2, 3, 67, false]);
  const over = budgetBars({ sources: null, session: "x".repeat(410 * 4), wake: null })[1];
  assert.deepEqual([over.pct, over.warn, over.note], [100, true, "Over budget by 10 tokens: a wrap resets it"]);
});

// ── SESSION.md ──

test("hasPromoteTag is wrap-session.js's: a trailing tag, not prose, never in a code span", () => {
  assert.equal(hasPromoteTag("- keep this #promote"), true);
  assert.equal(hasPromoteTag("- keep this #promote #later."), true);
  assert.equal(hasPromoteTag("- none tagged #promote in this session"), false);
  assert.equal(hasPromoteTag("- the `#promote` tag is how"), false);
  assert.equal(hasPromoteTag("- plain line"), false);
});

/** The template wrap-session.js resets SESSION.md to, filled in. */
const SESSION = [
  "---", "type: session", "updated: 2026-10-11", "---", "",
  "# Current Session Working Memory", "",
  "> Ephemeral — cleared/promoted at session end. Max ~400 tokens.", "",
  "## Active Task", "",
  "## Key Context This Session", "",
  "- a fact the wrap summarised",
  "- feedback: project memories need a status once shipped #promote", "",
  "## Things to Remember", "",
  "- resume with the folder flag to skip the prompt",
  "* keep the second bullet style too #promote", "",
  "## Promote to Memory on Close", "",
  "- reference: the build needs the newer toolchain", "",
].join("\n");

test("sessionCard: Things to Remember, Promote to Memory on Close and #promote lines elsewhere; the tag is shown apart", () => {
  const c = sessionCard(SESSION)!;
  assert.deepEqual(c.lines, [
    { text: "feedback: project memories need a status once shipped", promote: true, section: "other" },
    { text: "resume with the folder flag to skip the prompt", promote: false, section: "remember" },
    { text: "keep the second bullet style too", promote: true, section: "remember" },
    { text: "reference: the build needs the newer toolchain", promote: true, section: "promote" },
  ]);
  assert.equal(c.tokens, estimateTokens(SESSION));
  assert.equal(c.notWrapped, false);
  assert.deepEqual(wrapNote(c, "/wrap"), { text: "The next wrap promotes the tagged lines", warn: false });
  assert.equal(sessionCard(null), null);
  const empty = sessionCard("# SESSION\n\n## Key Context This Session\n\n## Things to Remember\n")!;
  assert.deepEqual(empty.lines, []);
  assert.equal(wrapNote(empty, "/wrap"), null);
});

test("sessionCard: the not-wrapped line auto-wrap.js writeWrapStatus writes, and how it says to wrap on each host", () => {
  // auto-wrap.js: `- Session ${id} not wrapped (provider: ${name}) — run ${host.invocationHint('wrap')}.`
  const withStatus = (hint: string): string => `${SESSION}\n## Wrap Status\n\n- Session abc123 not wrapped (provider: none) — run ${hint}.\n`;
  const claude = sessionCard(withStatus("/wrap"))!;
  assert.equal(claude.notWrapped, true);
  assert.equal(claude.wrapHint, "/wrap");
  assert.ok(!claude.lines.some((l) => /not wrapped/.test(l.text)), "the status line is not a line to remember");
  assert.deepEqual(wrapNote(claude, "$agenticos:wrap"), { text: "Not wrapped yet · /wrap promotes the tagged lines", warn: true }, "the line's own command wins");
  assert.equal(sessionCard(withStatus("$agenticos:wrap"))!.wrapHint, "$agenticos:wrap");
  const both = sessionCard(withStatus("/wrap (Claude Code) or $agenticos:wrap (Codex)"))!;
  assert.equal(both.wrapHint, "/wrap (Claude Code) or $agenticos:wrap (Codex)");
  const bare = sessionCard("# SESSION\n\n## Wrap Status\n\n- Session s1 not wrapped (provider: none) — run $wrap.\n\n## Things to Remember\n")!;
  assert.deepEqual(wrapNote(bare, "/wrap"), { text: "Not wrapped yet · run $wrap", warn: true });
  // A not-wrapped line that names no command (written by hand): /wrap as this machine's hosts invoke it, never /wrap
  // on a Codex-only vault.
  const none = sessionCard("# SESSION\n\n## Wrap Status\n\n- Session s1 not wrapped\n\n## Things to Remember\n\n- keep this #promote\n")!;
  assert.equal(none.wrapHint, null);
  assert.deepEqual(wrapNote(none, "$agenticos:wrap"), { text: "Not wrapped yet · $agenticos:wrap promotes the tagged lines", warn: true });
  assert.deepEqual(wrapNote(none, "/wrap"), { text: "Not wrapped yet · /wrap promotes the tagged lines", warn: true });
  // "not wrapped" outside the Wrap Status section is prose, not the status.
  assert.equal(sessionCard("# S\n\n## Things to Remember\n\n- lines are not wrapped at 80 columns\n")!.notWrapped, false);
});

// ── MEMORY.md ──

test("indexCard: size in KB, about N tokens, lines; Health's index findings in words", () => {
  const raw = `# Memory index\n\n## Projects\n- [Café](${P("projects", "cafe")}) — naïve ünïcode\n`;
  const c = indexCard(raw, null)!;
  assert.equal(c.bytes, new TextEncoder().encode(raw).length);
  assert.ok(c.bytes > raw.length, "bytes, not characters");
  assert.equal(c.lines, 3, "non-blank lines, as Health's MEMORY.md tile counts them");
  assert.equal(c.lines, indexLineCount(raw));
  assert.equal(c.size, `${c.bytes} bytes · about ${estimateTokens(raw)} tokens · 3 lines`);
  assert.deepEqual([c.findings, c.fixable], [[], 0]);
  const big = indexCard("x".repeat(69_222) + "\nlast", null)!;
  assert.equal(big.size, "67.6 KB · about 17k tokens · 2 lines");
  assert.equal(indexCard("y".repeat(6000), null)!.size, "5.9 KB · about 1.5k tokens · 1 line");
  assert.equal(indexCard(null, null), null);
  const hub = parseBrainHub(JSON.stringify({ schema: 1, hygiene: { misfiled: [P("user", "a"), P("user", "b")], unindexed: [P("projects", "c")], brokenIndex: [P("reference", "d")] } }));
  const h = indexCard(raw, hub)!;
  assert.deepEqual(h.findings, ["2 lines sit under the wrong heading.", "1 memory has no line in it.", "1 line points at a missing file."]);
  assert.equal(h.fixable, 4);
  const one = indexCard(raw, parseBrainHub(JSON.stringify({ schema: 1, hygiene: { misfiled: [P("user", "a")], unindexed: [P("a", "b"), P("c", "d")], brokenIndex: [P("e", "f"), P("g", "h")] } })))!;
  assert.deepEqual(one.findings, ["1 line sits under the wrong heading.", "2 memories have no line in it.", "2 lines point at a missing file."]);
});

// ── the recall preview ──

test("scoreText and hitAge: three significant figures for either ranking; the age flag and its stale word", () => {
  assert.equal(scoreText(4.2134), "4.21");
  assert.equal(scoreText(0.032787), "0.0328");
  assert.equal(scoreText(12.5), "12.5");
  assert.equal(scoreText(3), "3");
  assert.equal(scoreText(Number.NaN), "");
  assert.deepEqual(hitAge("12d"), { age: "12d", stale: false });
  assert.deepEqual(hitAge("stale: 61d"), { age: "61d", stale: true });
  assert.deepEqual(hitAge(""), { age: "", stale: false });
  assert.deepEqual(hitAge("stale"), { age: "", stale: true });
});

test("recallRows: a memory opens in Library, a stale hit says so, another file opens in the editor, a gone memory does nothing", () => {
  const f = fixture();
  const pattern = parseNote("patterns", "brain/patterns/release-steps.md", "# Release steps\n\nTag, build, notarize.\n")!;
  const rows = recallRows([
    { path: P("projects", "widget-release"), score: 0.0328, flag: "4d", snippet: "The cockpit went out…" },
    { path: P("projects", "ledger"), score: 3.1, flag: "stale: 90d", snippet: "" },
    { path: "brain/patterns/release-steps.md", score: 2, flag: "75d", snippet: "Tag, build" },
    { path: "2026/2026-10-October/2026-10-09.md", score: 1.5, flag: "2d", snippet: "" },
    { path: "persona/journal/week-41.md", score: 1.2, flag: "5d", snippet: "" },
    { path: P("projects", "deleted-since"), score: 1, flag: "9d", snippet: "" },
    { path: "../outside.md", score: 0.5, flag: "1d", snippet: "" },
  ], f.byPath, [pattern]);
  assert.deepEqual(rows.map((r) => [r.title, r.kind, r.score, r.age, r.stale, r.open]), [
    ["Widget 1.5.0 release", "projects", "0.0328", "4d", false, "memory"],
    ["Ledger tool", "projects", "3.1", "90d", true, "memory"],
    ["Release steps", "pattern", "2", "75d", false, "file"],
    ["2026-10-09", "daily note", "1.5", "2d", false, "file"],
    ["week-41", "journal", "1.2", "5d", false, "file"],
    ["deleted-since", "gone from the store", "1", "9d", false, "none"],
    ["outside", "note", "0.5", "1d", false, "none"],
  ]);
  assert.equal(rows[0].snippet, "The cockpit went out…");
});

test("openablePath: vault-relative markdown only", () => {
  assert.equal(openablePath("brain/patterns/x.md"), true);
  assert.equal(openablePath("/etc/x.md"), false);
  assert.equal(openablePath("a/../b.md"), false);
  assert.equal(openablePath("brain/x.json"), false);
  assert.equal(openablePath("a\nb.md"), false);
});
