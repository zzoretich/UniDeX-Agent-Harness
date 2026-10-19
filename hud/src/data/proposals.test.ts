import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createRequire } from "module";
import {
  PROPOSALS_DIR, LEDGER_PATH, CONFIRMATIONS_PATH, isProposalFile, parseProposal, parseLedger, ledgerRates,
  historyRows, parseBacklog, parseConfirmations, ageDays, decisionFor, pageFor, pageForSlug,
} from "./proposals";

// The fixture vault is read by both sides: this module and the runtime scripts it mirrors.
const VAULT = path.resolve(__dirname, "fixtures/proposals-vault");
const REPO = path.resolve(__dirname, "../../..");
const req = createRequire(__filename);
const collectJs = req(path.join(REPO, "plugin/skills/persona-flag-closer/scripts/collect.js"));
const ledgerJs = req(path.join(REPO, "brain/scripts/persona/ledger.js"));
const backlogJs = req(path.join(REPO, "brain/scripts/persona/backlog.js"));
const recheckJs = req(path.join(REPO, "brain/scripts/persona/recheck.js"));

const read = (rel: string) => fs.readFileSync(path.join(VAULT, rel), "utf8");
const proposals = () => fs.readdirSync(path.join(VAULT, PROPOSALS_DIR)).filter(isProposalFile).sort()
  .map((f) => parseProposal(f, read(`${PROPOSALS_DIR}/${f}`)));

test("every fixture proposal parses to the same fields and lint as collect.js", () => {
  const theirs = collectJs.collect(VAULT, { stateDir: path.join(os.tmpdir(), "aos-no-state") }).proposals;
  const ours = proposals();
  assert.deepEqual(ours.map((p) => p.name), theirs.map((p: { file: string }) => path.basename(p.file)));
  for (const [i, p] of ours.entries()) {
    const t = theirs[i];
    assert.deepEqual(
      { slug: p.slug, filed: p.filed, kind: p.kind, surface: p.surface, workspace: p.workspace, target: p.target,
        recheck: p.recheck, autoapplyClass: p.autoapplyClass, premises: p.premises, lint: p.lint },
      { slug: t.slug, filed: t.filed, kind: t.kind, surface: t.surface, workspace: t.workspace, target: t.target,
        recheck: t.recheck, autoapplyClass: t.autoapply_class, premises: t.premises, lint: t.lint },
      p.name,
    );
  }
});

test("the workspace key (spaces-redesign D27): /propose's line is read on both sides, absent is null", () => {
  const byName = Object.fromEntries(proposals().map((p) => [p.name, p]));
  assert.equal(byName["2026-09-20-todo-in-sitrep.md"].workspace, "site");
  assert.equal(byName["2026-09-18-trim-playbook.md"].workspace, null);
  // Hand-written forms read as a memory note's `workspace:` is (memories.ts workspaceKey), the same in collect.js.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-prop-ws-"));
  const raws: Array<[string, string | null]> = [
    ["site", "site"], ['"My App"', "My App"], ["'site'", "site"], ["workspaces/site/", "site"],
    ["\"[[workspaces/site|Site]]\"", "site"], ["", null], ['""', null], ["workspaces/", null],
  ];
  fs.mkdirSync(path.join(dir, PROPOSALS_DIR), { recursive: true });
  const names = raws.map((_, i) => `2026-10-0${i + 1}-ws-${i}.md`);
  raws.forEach(([raw], i) => fs.writeFileSync(path.join(dir, PROPOSALS_DIR, names[i]), `---\nslug: ws-${i}\nworkspace: ${raw}\n---\n## What\nx\n`));
  const theirs = collectJs.collect(dir, { stateDir: path.join(dir, "state") }).proposals;
  raws.forEach(([raw, want], i) => {
    const ours = parseProposal(names[i], fs.readFileSync(path.join(dir, PROPOSALS_DIR, names[i]), "utf8"));
    assert.equal(ours.workspace, want, `ours: ${raw}`);
    assert.equal(theirs[i].workspace, want, `collect.js: ${raw}`);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the README is not a proposal, and each lint path fires", () => {
  const byName = Object.fromEntries(proposals().map((p) => [p.name, p]));
  assert.equal(byName["README.md"], undefined);
  assert.deepEqual(byName["2026-09-18-trim-playbook.md"].lint, []);
  assert.equal(byName["2026-09-18-trim-playbook.md"].recheck, 'grep -q "old heading" persona/PLAYBOOK.md');
  assert.deepEqual(byName["2026-09-21-no-surface.md"].lint, [
    "missing recheck recipe", "missing premise table", "product proposal names no surface (cli | plugin | brain | hud | vault-template | docs)",
  ]);
  assert.equal(byName["2026-09-21-no-surface.md"].slug, "no-surface");
  assert.equal(byName["2026-09-21-odd-kind.md"].filed, "2026-09-21");
  assert.equal(byName["2026-09-21-odd-kind.md"].lint.length, 2);
});

test("What, Why and Risk sections are extracted; the decision label follows the kind", () => {
  const p = proposals()[0];
  assert.match(p.what ?? "", /^Remove the `## Old heading` section/);
  assert.match(p.why ?? "", /journal 2026-09-17/);
  assert.equal(p.risk, "None beyond losing a stale line.");
  assert.equal(proposals()[2].what?.includes("no surface"), true);
  assert.equal(proposals()[3].what, null);
  assert.equal(decisionFor("self"), "approve / reject");
  assert.equal(decisionFor("product"), "accept → backlog / dismiss");
  assert.equal(p.decision, "approve / reject");
});

test("ledger rates match ledger.js summary() over the same window", () => {
  const records = parseLedger(read(LEDGER_PATH));
  const now = new Date("2026-09-22T12:00:00Z");
  const origError = console.error;
  console.error = () => {};   // ledger.js warns once about the fixture's corrupt line
  let theirs;
  try { theirs = ledgerJs.summary({ file: path.join(VAULT, LEDGER_PATH), now }); } finally { console.error = origError; }
  const ours = ledgerRates(records, now);
  assert.equal(records.length, 12, "the corrupt line is skipped");
  assert.equal(ours.approvalRate, theirs.approvalRate);
  assert.equal(ours.acceptRate, theirs.acceptRate);
  assert.equal(ours.approvalRate, 0.5, "one approval, one rejection inside 28 days; the August rejection is outside");
  assert.equal(ours.acceptRate, 0.5);
  assert.deepEqual(ledgerRates([], now), { days: 28, counts: {}, approvalRate: null, acceptRate: null });
});

test("history lists outcomes newest first and leaves out filed events", () => {
  const rows = historyRows(parseLedger(read(LEDGER_PATH)));
  assert.equal(rows.every((r) => r.event !== "filed"), true);
  assert.deepEqual(rows.slice(0, 3).map((r) => `${r.event}:${r.slug}`), ["verified:quiet-hooks", "dismissed:idea-two", "accepted:idea-one"]);
  assert.equal(historyRows(parseLedger(read(LEDGER_PATH)), 2).length, 2);
});

test("parseBacklog reads what backlog.js append writes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-backlog-"));
  const file = path.join(dir, "backlog.md");
  const now = new Date("2026-09-22T09:00:00Z");
  backlogJs.append({ proposal: path.join(VAULT, PROPOSALS_DIR, "2026-09-20-todo-in-sitrep.md"), file, by: "user", now });
  const entries = parseBacklog(fs.readFileSync(file, "utf8"));
  assert.equal(entries.length, 1);
  const e = entries[0];
  assert.deepEqual({ filed: e.filed, kind: e.kind, slug: e.slug, target: e.target, surface: e.surface, accepted: e.accepted },
    { filed: "2026-09-20", kind: "product", slug: "todo-in-sitrep", target: "the morning sitrep", surface: "hud", accepted: "2026-09-22 by user" });
  assert.match(e.body, /^### What\n\nList todos due today in the sitrep\.\n\n### Why\n\nThe owner asked for it twice\.$/);
  assert.deepEqual(parseBacklog("# Persona backlog\n\nno sections yet\n"), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("parseConfirmations matches recheck.js readConfirmations for both shapes", () => {
  assert.deepEqual(parseConfirmations(read(CONFIRMATIONS_PATH)), recheckJs.readConfirmations(VAULT).slugs);
  assert.deepEqual(parseConfirmations(read(CONFIRMATIONS_PATH)), { "trim-playbook": 2, "todo-in-sitrep": 1 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-conf-"));
  const legacy = '{ "old-one": 3, "bad": -1, "frac": 1.5, "recordedDay": "2026-09-01" }';
  fs.mkdirSync(path.join(dir, "persona/flag-closer"), { recursive: true });
  fs.writeFileSync(path.join(dir, CONFIRMATIONS_PATH), legacy);
  assert.deepEqual(parseConfirmations(legacy), recheckJs.readConfirmations(dir).slugs);
  assert.deepEqual(parseConfirmations(legacy), { "old-one": 3 });
  assert.deepEqual(parseConfirmations(null), {});
  assert.deepEqual(parseConfirmations("[1,2]"), {});
  assert.deepEqual(parseConfirmations("{nope"), {});
  fs.rmSync(dir, { recursive: true, force: true });
});

test("ageDays counts local calendar days", () => {
  const now = new Date(2026, 8, 22, 0, 5);   // just after local midnight
  assert.equal(ageDays("2026-09-22", now), 0);
  assert.equal(ageDays("2026-09-20", now), 2);
  assert.equal(ageDays("2026-08-31", now), 22);
  assert.equal(ageDays("(unspecified)", now), null);
});

test("pageFor matches proposal-html.js pagePath; pageForSlug finds the newest page for a slug, exactly", () => {
  const htmlJs = req(path.join(REPO, "brain/scripts/persona/proposal-html.js"));
  for (const name of fs.readdirSync(path.join(VAULT, PROPOSALS_DIR)).filter(isProposalFile)) {
    assert.equal(pageFor(name), path.relative(VAULT, htmlJs.pagePath(VAULT, name)).split(path.sep).join("/"));
  }
  const pages = ["2026-09-01-trim-playbook.html", "2026-09-18-trim-playbook.html", "2026-09-18-trim-playbook-more.html", "notes.html", "2026-09-19-x.md"];
  assert.equal(pageForSlug(pages, "trim-playbook"), "brain/_index/proposals/2026-09-18-trim-playbook.html");
  assert.equal(pageForSlug(pages, "playbook"), null);
  assert.equal(pageForSlug(pages, "x"), null);
  assert.equal(pageForSlug([], "trim-playbook"), null);
});
