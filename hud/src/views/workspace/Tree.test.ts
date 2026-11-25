import { test } from "node:test";
import assert from "node:assert/strict";
import { foldTeams, focusRow, parentOf, rowState, renderNoTeams, UNSCANNED } from "./Tree";
import { NO_AGENTS, NO_TEAMS } from "../../data/workspace";
import type { TreeRow } from "../../data/workspace";

const r = (key: string, kind: TreeRow["kind"], depth: number, extra: Partial<TreeRow> = {}): TreeRow => ({ key, kind, label: key, depth, tone: null, ...extra });

// The fixture's shape: Example with its members and the Survey sub-team under it, a broken team, the bench, plugins.
const ROWS: TreeRow[] = [
  r("needs", "needs", 0, { count: 2 }),
  r("section:teams", "section", 0, { count: 3 }),
  r("team:broken", "team", 1, { broken: true }),
  r("team:example", "team", 1, { count: 1 }),
  r("agent:team-lead", "member", 2, { lead: true }),
  r("agent:team-builder", "member", 2),
  r("team:survey", "team", 2),
  r("agent:survey-lead", "member", 3, { lead: true }),
  r("agent:team-builder", "member", 3),
  r("section:bench", "section", 0, { count: 0 }),
  r("section:plugins", "section", 0, { count: 4 }),
];
const keys = (rows: TreeRow[]) => rows.map((x) => x.key);

test("foldTeams: a folded team hides its members and its sub-team; the next team at its depth shows again", () => {
  const shown = foldTeams(ROWS, new Set(["team:example"]));
  assert.deepEqual(keys(shown), ["needs", "section:teams", "team:broken", "team:example", "section:bench", "section:plugins"]);
  assert.equal(shown.find((x) => x.key === "team:example")?.folded, true);
  // A sub-team folds alone; its parent's members stay.
  assert.deepEqual(keys(foldTeams(ROWS, new Set(["team:survey"]))), keys(ROWS).filter((k, i) => i < 7 || i > 8));
});

test("foldTeams: a team with nothing under it is never folded; a filter ignores the folds; sections are workspaceTree's", () => {
  const shown = foldTeams(ROWS, new Set(["team:broken", "section:teams"]));
  assert.deepEqual(keys(shown), keys(ROWS));
  assert.equal(shown.find((x) => x.key === "team:broken")?.folded, undefined);
  assert.deepEqual(keys(foldTeams(ROWS, new Set(["team:example"]), "sur")), keys(ROWS));
  assert.deepEqual(keys(foldTeams(ROWS, new Set(["team:example"]), "  ")), keys(foldTeams(ROWS, new Set(["team:example"]))));
});

test("parentOf: the row a row sits under, -1 at the top", () => {
  assert.equal(parentOf(ROWS, 4), 3, "a member sits under its team");
  assert.equal(parentOf(ROWS, 6), 3, "a sub-team under its parent");
  assert.equal(parentOf(ROWS, 8), 6);
  assert.equal(parentOf(ROWS, 3), 1, "a team under TEAMS");
  assert.equal(parentOf(ROWS, 1), -1);
  assert.equal(parentOf(ROWS, 0), -1);
});

test("rowState: sections fold when they hold something, teams when they have rows under them, the note never", () => {
  const at = (key: string, rows = ROWS) => rowState(rows, rows.findIndex((x) => x.key === key));
  assert.deepEqual(at("section:teams"), { open: true, foldable: true, pickable: false, note: false });
  assert.deepEqual(at("section:plugins"), { open: false, foldable: true, pickable: false, note: false }, "folded with 4 inside");
  assert.deepEqual(at("section:bench"), { open: false, foldable: false, pickable: false, note: false }, "empty: nothing to fold");
  assert.deepEqual(at("team:example"), { open: true, foldable: true, pickable: true, note: false });
  assert.deepEqual(at("team:broken"), { open: false, foldable: false, pickable: true, note: false });
  assert.deepEqual(at("needs"), { open: false, foldable: false, pickable: true, note: false });
  const folded = foldTeams(ROWS, new Set(["team:example"]));
  assert.deepEqual(at("team:example", folded), { open: false, foldable: true, pickable: true, note: false });
  // No agents cache: BENCH holds a note that is neither folded nor picked, though BENCH itself can fold it away.
  const unscanned = [r("section:bench", "section", 0, { count: 0 }), r(UNSCANNED, "section", 1)];
  assert.deepEqual(rowState(unscanned, 1), { open: false, foldable: false, pickable: false, note: true });
  assert.deepEqual(rowState(unscanned, 0), { open: true, foldable: true, pickable: false, note: false });
});

test("rowState: No teams yet and BENCH's empty line are notes, never folded or picked; TEAMS folds them away", () => {
  const empty = [r("section:teams", "section", 0, { count: 0 }), r(NO_TEAMS, "section", 1), r("section:bench", "section", 0, { count: 0 }), r(NO_AGENTS, "section", 1)];
  for (const i of [1, 3]) assert.deepEqual(rowState(empty, i), { open: false, foldable: false, pickable: false, note: true });
  assert.deepEqual(rowState(empty, 0), { open: true, foldable: true, pickable: false, note: false });
});

// A small fake of Obsidian's DOM helpers, for what the No teams yet note holds.
type Opts = { cls?: string; text?: string; attr?: Record<string, string> };
class El {
  kids: El[] = [];
  cls: Set<string>;
  attrs: Map<string, string>;
  disabled = false;
  private on = new Map<string, (() => void)[]>();
  constructor(public tag: string, o: Opts = {}, public own = o.text ?? "") {
    this.cls = new Set((o.cls ?? "").split(/\s+/).filter(Boolean));
    this.attrs = new Map(Object.entries(o.attr ?? {}));
  }
  createEl(tag: string, o?: Opts): El { const e = new El(tag, o); this.kids.push(e); return e; }
  createDiv(o?: Opts): El { return this.createEl("div", o); }
  createSpan(o?: Opts): El { return this.createEl("span", o); }
  addEventListener(ev: string, fn: () => void): void { this.on.set(ev, [...(this.on.get(ev) ?? []), fn]); }
  click(): void { for (const fn of this.on.get("click") ?? []) fn(); }
  get text(): string { return this.own + this.kids.map((k) => k.text).join(""); }
  all(): El[] { return [this, ...this.kids.flatMap((k) => k.all())]; }
}

test("renderNoTeams: Seed the example team and + New team, the hint, a seed's refusal; Seeding… while it runs", () => {
  let seeds = 0, news = 0;
  const box = new El("div");
  const o = { seeding: false, error: null as string | null, hint: "It lands in persona/teams/example/. In a session: /team.", seed: () => { seeds++; }, newTeam: () => { news++; } };
  renderNoTeams(box as unknown as HTMLElement, o);
  const buttons = box.all().filter((e) => e.tag === "button");
  assert.deepEqual(buttons.map((b) => b.text), ["Seed the example team", "+ New team"]);
  assert.ok(buttons.every((b) => b.attrs.get("type") === "button" && !b.disabled));
  assert.ok(buttons[1].cls.has("aos-aw-primary"));
  assert.match(buttons[0].attrs.get("title") ?? "", /^aos team init/);
  buttons[0].click();
  buttons[1].click();
  assert.deepEqual([seeds, news], [1, 1]);
  assert.ok(box.all().some((e) => e.cls.has("aos-aw-notehint") && e.text === o.hint));
  assert.ok(!box.all().some((e) => e.cls.has("aos-aw-error")));

  const busy = new El("div");
  renderNoTeams(busy as unknown as HTMLElement, { ...o, seeding: true, error: "persona/teams/example already exists" });
  const [seed] = busy.all().filter((e) => e.tag === "button");
  assert.equal(seed.text, "Seeding…");
  assert.equal(seed.disabled, true);
  const err = busy.all().find((e) => e.cls.has("aos-aw-error"));
  assert.equal(err?.text, "persona/teams/example already exists");
  assert.equal(err?.attrs.get("role"), "alert");
});

test("focusRow: a redraw gives the row the keyboard back without scrolling the tree; scroll: true brings it into view", () => {
  // A row as the tree draws it: its key in data-key; focus records whether it was asked not to scroll.
  const calls: [string, boolean | undefined][] = [];
  const row = (key: string, id: string) => ({ dataset: { key }, focus: (o?: FocusOptions) => { calls.push([id, o?.preventScroll]); } });
  const rows = [row("team:example", "a"), row("agent:team-builder", "b"), row("agent:team-builder", "c")];
  const host = { querySelectorAll: (sel: string) => (sel === ".aos-aw-row" ? rows : []) } as unknown as HTMLElement;
  focusRow(host, { key: "agent:team-builder", nth: 1 });
  assert.deepEqual(calls, [["c", true]], "the row that had it, never scrolled to (a redraw keeps where the tree was scrolled)");
  focusRow(host, { key: "team:example", nth: 0 }, { scroll: true });
  assert.deepEqual(calls[1], ["a", false], "a redraw the user's own key in the tree caused shows the row");
  focusRow(host, { key: "agent:team-builder", nth: 5 });
  assert.deepEqual(calls[2], ["b", true], "a row whose place is gone falls back to the key's first");
  focusRow(host, { key: "agent:gone", nth: 0 });
  focusRow(host, null);
  assert.equal(calls.length, 3, "nothing to give it back to");
});
