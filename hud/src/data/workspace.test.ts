import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { Team, TeamFiles, readTeams, teamFrom, parseJsonl, latestRows, diskAdapter } from "./teams";
import { activityOf, ACTIVITY_PAGE } from "./workspace";

const VAULT = path.resolve(__dirname, "fixtures/teams-vault");
const LAB_BOARD = path.join(VAULT, "persona/teams/lab/board.jsonl");

async function lab(): Promise<Team> {
  const t = (await readTeams(diskAdapter(VAULT))).find((x) => x.id === "lab");
  assert.ok(t, "no lab team");
  return t;
}

test("history keeps every complete board row and the board is unchanged", async () => {
  const t = await lab();
  const rows = parseJsonl(fs.readFileSync(LAB_BOARD, "utf8")).rows;
  assert.equal(t.history.length, rows.length);
  assert.deepEqual(t.history.map((h) => h.raw), rows);
  assert.deepEqual(t.board.map((b) => b.raw), [...latestRows(rows).values()]);
});

test("activity: the lab's gate, runs, marker and posts, newest first", async () => {
  const ev = activityOf(await lab());
  const ts = ev.map((e) => e.ts);
  assert.deepEqual(ts, [...ts].sort().reverse());
  assert.ok(ev.some((e) => e.kind === "gate-open" && e.item === "site-01" && e.ts === "2026-09-20T12:00:00.000Z"));
  assert.equal(ev.filter((e) => e.kind === "gate-open" && e.item === "site-01").length, 1);
  assert.ok(ev.some((e) => e.kind === "run-end" && e.member === "reviewer" && e.item === "site-03"));
  assert.ok(ev.some((e) => e.kind === "run-start" && e.member === "builder" && e.item === "site-02" && e.ts === "2026-09-20T12:50:00.000Z"));
  assert.ok(ev.some((e) => e.kind === "item-new" && e.item === "site-00"));
  assert.ok(ev.some((e) => e.kind === "gate-decided" && e.item === "site-02" && e.ts === "2026-09-20T10:30:00.000Z"));
  assert.ok(ev.every((e) => e.item !== "site-04"));
  assert.ok(ev.some((e) => e.kind === "post" && e.member === "lead"));
  assert.ok(!ev.some((e) => e.kind === "post" && e.item === "site-01" && e.ts === "2026-09-20T12:00:00.000Z"), "a gate post is folded into gate-open");
  const open = ev.find((e) => e.kind === "gate-open" && e.item === "site-01");
  assert.ok(open?.text.endsWith('"Discuss gate open on site-01: scope is the landing page; I propose $20, with $3.44 spent. See notes@lead, or ask @user."'));
  assert.ok(ACTIVITY_PAGE === 50);
});

test("no gate post is a post event for any fixture team", async () => {
  for (const t of await readTeams(diskAdapter(VAULT))) {
    const gateTexts = new Set(t.channel.filter((p) => p.kind === "gate").map((p) => p.text));
    assert.ok(!activityOf(t).some((e) => e.kind === "post" && [...gateTexts].some((g) => e.text.endsWith(g))), t.id);
  }
});

test("a gate-open takes the latest earlier lead pitch, or none", () => {
  const row = (ts: string, id: string) => JSON.stringify({ ts, by: "lead", id, title: id, stage: "discuss", owner: "lead", status: "gate", gate: { name: "discuss", state: "pending" } });
  const post = (ts: string, text: string, item: string) => JSON.stringify({ ts, from: "lead", kind: "gate", item, text });
  const t = teamFrom({
    id: "x", teamMd: "---\nname: X\nlead: lead\n---\n", runs: null, markers: [], state: null, disabled: false,
    board: [row("2026-01-01T00:10:00.000Z", "a-1"), row("2026-01-01T00:10:00.000Z", "b-1")].join("\n") + "\n",
    channel: [post("2026-01-01T00:01:00.000Z", "old", "a-1"), post("2026-01-01T00:09:00.000Z", "new", "a-1"), post("2026-01-01T00:11:00.000Z", "later", "b-1")].join("\n") + "\n",
  });
  const ev = activityOf(t).filter((e) => e.kind === "gate-open");
  assert.ok(ev.find((e) => e.item === "a-1")?.text.endsWith('"new"'));
  assert.ok(!ev.find((e) => e.item === "b-1")?.text.includes('"'));
  assert.ok(!activityOf(t).some((e) => e.kind === "post"));
});

test("a user gate post is left out", () => {
  const t = teamFrom({
    id: "x", teamMd: "---\nname: X\nlead: lead\n---\n", board: null, runs: null, markers: [], state: null, disabled: false,
    channel: [
      JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", from: "user", kind: "gate", item: "a-1", text: "approved" }),
      JSON.stringify({ ts: "2026-01-01T00:01:00.000Z", from: "user", kind: "note", item: null, text: "hello" }),
    ].join("\n") + "\n",
  });
  const ev = activityOf(t);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, "post");
  assert.equal(ev[0].text.endsWith("hello"), true);
});

test("activity over 2,000 generated rows stays sorted and one row can give two events", () => {
  const rows: string[] = [];
  const base = Date.parse("2026-02-01T00:00:00.000Z");
  const at = (i: number) => new Date(base + i * 60000).toISOString();
  for (let i = 0; i < 2000; i++) {
    const id = `g-${i % 40}`;
    rows.push(JSON.stringify({ ts: at(i), by: "lead", id, title: id, stage: i < 40 ? "discuss" : "plan", owner: "a", status: "working", gate: null, budget: { usd: 10 + (i % 3) } }));
  }
  // one row that both moves the stage and records a user decision
  rows.push(JSON.stringify({ ts: at(2001), by: "lead", id: "g-0", title: "g-0", stage: "execute", owner: "a", status: "working", gate: { name: "plan", state: "approved", by: "user", ts: at(2000) }, budget: { usd: 12 } }));
  const files: TeamFiles = { id: "big", teamMd: "---\nname: Big\nlead: lead\n---\n", board: rows.join("\n") + "\n", channel: null, runs: null, markers: [], state: null, disabled: false };
  const t = teamFrom(files);
  assert.equal(t.history.length, 2001);
  const ev = activityOf(t);
  const ts = ev.map((e) => e.ts);
  assert.deepEqual(ts, [...ts].sort().reverse());
  const mine = ev.filter((e) => e.item === "g-0" && e.ts >= at(2000));
  assert.ok(mine.some((e) => e.kind === "gate-decided" && e.ts === at(2000)));
  assert.ok(mine.some((e) => e.kind === "stage" && e.ts === at(2001)));
  assert.equal(ev.filter((e) => e.kind === "item-new").length, 40);
});
