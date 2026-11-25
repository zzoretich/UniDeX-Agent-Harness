import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import { Team, readTeams, diskAdapter, teamFrom, gateCards } from "../../data/teams";
import { parseAgents } from "../../data/agents";
import { ACTIVITY_PAGE, activityOf } from "../../data/workspace";
import type { SessionHost } from "../../data/aosConfig";
import type { TeamsCtx, TeamsView, Confirm } from "../teams/ui";
import { since } from "../teams/ui";
import { renderActivity } from "./ActivityPane";
import { renderTeamPane, teamView } from "./TeamPane";
import { renderNeeds } from "./NeedsPane";
import { renderItems } from "./ItemsPane";
import { renderSettings } from "./SettingsPane";

// The Agent Workspace's Needs you, team and Activity panes (spec 2026-11-12-agent-workspace-design D5-D7), drawn into a
// small fake of Obsidian's DOM helpers and driven through the ctx the tab hands them, against the shared fixture vault.
const VAULT = path.resolve(__dirname, "../../data/fixtures/teams-vault");
const NOW = new Date("2026-09-20T13:00:00.000Z");

type Opts = { cls?: string; text?: string; attr?: Record<string, string>; href?: string };
type Ev = { key?: string; target?: El };
class El {
  kids: El[] = [];
  cls = new Set<string>();
  attrs = new Map<string, string>();
  own: string;
  disabled = false;
  focused = false;
  value = "";
  private on = new Map<string, ((e: unknown) => void)[]>();
  constructor(public tag: string, o: Opts = {}) {
    for (const c of (o.cls ?? "").split(/\s+/).filter(Boolean)) this.cls.add(c);
    for (const [k, v] of Object.entries(o.attr ?? {})) this.attrs.set(k, v);
    this.own = o.text ?? "";
  }
  createEl(tag: string, o?: Opts): El { const e = new El(tag, o); this.kids.push(e); return e; }
  createDiv(o?: Opts): El { return this.createEl("div", o); }
  createSpan(o?: Opts): El { return this.createEl("span", o); }
  appendText(s: string): void { this.kids.push(new El("#text", { text: s })); }
  setAttr(k: string, v: string): void { this.attrs.set(k, v); }
  addClass(c: string): void { this.cls.add(c); }
  empty(): void { this.kids = []; }
  setText(s: string): void { this.own = s; this.kids = []; }
  focus(): void { this.focused = true; }
  addEventListener(ev: string, fn: (e: unknown) => void): void { this.on.set(ev, [...(this.on.get(ev) ?? []), fn]); }
  get text(): string { return this.own + this.kids.map((k) => k.text).join(""); }
  all(): El[] { return [this, ...this.kids.flatMap((k) => k.all())]; }
  find(cls: string): El[] { return this.all().filter((e) => e.cls.has(cls)); }
  one(cls: string): El { const e = this.find(cls)[0]; assert.ok(e, `no .${cls}`); return e; }
  fire(ev: string, e: Ev = {}): void { for (const fn of this.on.get(ev) ?? []) fn({ preventDefault() {}, stopPropagation() {}, target: this, ...e }); }
  press(label: RegExp): void {
    const b = this.all().find((e) => (e.tag === "button" || e.tag === "a") && label.test(e.text));
    assert.ok(b && !b.disabled, `no enabled ${label}`);
    b.fire("click");
  }
}
const html = (e: El) => e as unknown as HTMLElement;

const AGENTS = parseAgents(JSON.stringify({ schema: 1, agents: [{ id: "team-lead", name: "team-lead", on: {
  claude: { invoke: "@agent-team-lead", run: "claude --agent team-lead" },
  codex: { invoke: "team-lead", run: "codex 'Use the team-lead agent. Ask me what it should work on.'" },
} }] }));

function harness(t: Team, teams: Team[] = [t], o: { hosts?: SessionHost[]; busy?: (k: string) => boolean; agents?: typeof AGENTS } = {}) {
  const acts: { key: string; args: string[]; confirm?: Confirm }[] = [];
  const terms: { cmd: string; host?: SessionHost }[] = [];
  const opened: string[] = [];
  const selects: [string, TeamsView | undefined, string | null | undefined][] = [];
  let renders = 0;
  const ui = {
    team: t.id, view: "activity" as TeamsView, gateUsd: new Map(), budgetUsd: new Map(), openItem: null, showDone: new Set<string>(),
    channelItem: null, drafts: new Map(), addPick: new Map(), activityPages: new Map<string, number>(),
  };
  const c = {
    app: {}, teams, team: t, agents: o.agents ?? AGENTS, hosts: o.hosts ?? ["claude"], presets: null, now: NOW, ui,
    teamCmd: "aos team", hostEnv: { claude: "", codex: "" },
    busy: o.busy ?? (() => false), error: () => null,
    act: async (key: string, args: string[], confirm?: Confirm) => { acts.push({ key, args, confirm }); return true; },
    term: (cmd: string, host?: SessionHost) => { terms.push({ cmd, host }); },
    render: () => { renders++; }, select: (id: string, view?: TeamsView, item?: string | null) => { selects.push([id, view, item]); },
    openFile: (p: string) => { opened.push(p); },
  } as unknown as TeamsCtx;
  return { c, ui, acts, terms, opened, selects, renders: () => renders };
}

/** Lets an act's .then run. */
const settled = () => new Promise<void>((r) => setImmediate(r));

async function fixture(): Promise<Team[]> { return readTeams(diskAdapter(VAULT)); }
async function team(id: string): Promise<Team> {
  const t = (await fixture()).find((x) => x.id === id);
  assert.ok(t, `no ${id} team`);
  return t;
}

/** A team whose channel holds `n` posts, a minute apart, the last one a minute before NOW. */
function chatty(n: number): Team {
  const rows = Array.from({ length: n }, (_, i) => JSON.stringify({
    ts: new Date(NOW.getTime() - (n - i) * 60_000).toISOString(), from: "lead", item: null, kind: i === n - 1 ? "blocker" : "note", text: `post ${i + 1}`,
  }));
  return teamFrom({
    id: "busy", disabled: false, markers: [], state: null, board: null, runs: null, channel: `${rows.join("\n")}\n`,
    teamMd: "---\nid: busy\nname: Busy\nlead: lead\nmembers:\n  - id: lead\n    name: Lead\n    agent: team-lead\n---\n",
  });
}

// ── Activity (D7) ──

test("activity: the first page newest first, each row its age, a tone dot and the text; older asks for the next page", () => {
  const t = chatty(ACTIVITY_PAGE * 2 + 20);
  const { c } = harness(t);
  let more = 0;
  const root = new El("section");
  renderActivity(html(root), c, 1, () => { more++; });
  const rows = root.find("aos-aw-event");
  assert.equal(rows.length, ACTIVITY_PAGE);
  const ev = activityOf(t);
  assert.equal(rows[0].one("aos-aw-evtext").text, "Lead: post 120");
  assert.equal(rows[0].one("aos-aw-evtime").text, since(ev[0].ts, NOW));
  assert.equal(rows[0].one("aos-aw-evtime").attrs.get("title"), ev[0].ts);
  assert.ok(rows[0].one("aos-aw-dot").cls.has("is-failed"), "a blocker's dot is red");
  assert.ok(rows[1].one("aos-aw-dot").cls.has("is-neutral"));
  assert.deepEqual(rows.map((r) => r.one("aos-aw-evtext").text), ev.slice(0, ACTIVITY_PAGE).map((e) => e.text));
  root.one("aos-aw-older").fire("click");
  assert.equal(more, 1);

  const two = new El("section");
  renderActivity(html(two), c, 2, () => {});
  assert.equal(two.find("aos-aw-event").length, ACTIVITY_PAGE * 2);
  assert.equal(two.find("aos-aw-older").length, 1);
  const all = new El("section");
  renderActivity(html(all), c, 3, () => {});
  assert.equal(all.find("aos-aw-event").length, ACTIVITY_PAGE * 2 + 20);
  assert.equal(all.find("aos-aw-older").length, 0, "nothing older is left");
});

test("activity: the lab's events as activityOf gives them; an empty feed is one dim line", async () => {
  const lab = await team("lab");
  const root = new El("section");
  renderActivity(html(root), harness(lab).c, 1, () => {});
  assert.deepEqual(root.find("aos-aw-evtext").map((e) => e.text), activityOf(lab).map((e) => e.text));
  assert.equal(root.find("aos-aw-older").length, 0);

  const quiet = teamFrom({ id: "quiet", disabled: false, markers: [], state: null, board: null, runs: null, channel: null, teamMd: "---\nid: quiet\nlead: lead\n---\n" });
  const none = new El("section");
  renderActivity(html(none), harness(quiet).c, 1, () => {});
  assert.equal(none.find("aos-aw-event").length, 0);
  assert.equal(none.find("aos-aw-older").length, 0);
  const note = none.one("aos-aw-empty");
  assert.ok(note.cls.has("aos-aw-dim"));
  assert.match(note.text, /^No activity yet/);
});

// ── the team pane (D6) ──

test("team pane: the header line and a talk button per enabled host that has the lead's agent", async () => {
  const lab = await team("lab");
  const both = harness(lab, [lab], { hosts: ["claude", "codex"] });
  const root = new El("section");
  renderTeamPane(html(root), both.c, "activity", () => {});
  assert.equal(root.one("aos-aw-panetitle").text, "Lab");
  assert.equal(root.one("aos-aw-teamline").text, "lead Lead · 3 members · 3 open · $3.44 this week");
  assert.deepEqual(root.find("aos-aw-talk").map((b) => b.text), ["❯_ talk to Lead · claude", "❯_ talk to Lead · codex"]);
  root.find("aos-aw-talk")[1].fire("click");
  assert.deepEqual(both.terms, [{ cmd: "codex 'Use the team-lead agent. Ask me what it should work on.'", host: "codex" }]);

  const one = new El("section");
  renderTeamPane(html(one), harness(lab).c, "activity", () => {});
  assert.deepEqual(one.find("aos-aw-talk").map((b) => b.text), ["❯_ talk to Lead"]);
  // A host without the lead's agent gets no button.
  const claudeOnly = parseAgents(JSON.stringify({ schema: 1, agents: [{ id: "team-lead", name: "team-lead", on: { claude: { invoke: "@agent-team-lead", run: "claude --agent team-lead" } } }] }));
  const some = new El("section");
  renderTeamPane(html(some), harness(lab, [lab], { hosts: ["claude", "codex"], agents: claudeOnly }).c, "activity", () => {});
  assert.deepEqual(some.find("aos-aw-talk").map((b) => b.text), ["❯_ talk to Lead · claude"]);
});

test("team pane: NOW names who is working or blocked and counts the rest", async () => {
  const lab = await team("lab");
  const root = new El("section");
  renderTeamPane(html(root), harness(lab).c, "activity", () => {});
  const now = root.one("aos-aw-now");
  assert.equal(now.one("aos-aw-nowlabel").text, "NOW");
  const who = now.find("aos-aw-who");
  assert.deepEqual(who.map((w) => w.one("aos-aw-whoname").text), ["Builder", "Reviewer"]);
  assert.ok(who[0].cls.has("is-working") && who[0].one("aos-aw-dot").cls.has("is-live"));
  assert.equal(who[0].one("aos-aw-whoitem").text, "site-02 · 10m");
  assert.ok(who[1].cls.has("is-blocked") && who[1].one("aos-aw-dot").cls.has("is-failed"));
  assert.equal(who[1].one("aos-aw-whoitem").text, "site-03");
  assert.equal(now.one("aos-aw-nowrest").text, "1 idle");

  // A paused team: nobody at work, every member counted paused.
  const ops = await team("ops");
  const quiet = new El("section");
  renderTeamPane(html(quiet), harness(ops).c, "activity", () => {});
  assert.equal(quiet.one("aos-aw-now").find("aos-aw-who").length, 0);
  assert.equal(quiet.one("aos-aw-nowrest").text, "nobody working · 2 paused");
});

test("team pane: this team's gate cards only, then Activity · Items · Channel · Settings with Activity's feed", async () => {
  const lab = await team("lab");
  const views: TeamsView[] = [];
  const root = new El("section");
  renderTeamPane(html(root), harness(lab, [lab, await team("ops")]).c, "activity", (v) => views.push(v));
  const gates = root.one("aos-aw-gates");
  assert.equal(gates.one("aos-aw-gateshead").text, "NEEDS YOU · 1");
  assert.deepEqual(gates.find("aos-at-gate").map((g) => g.one("aos-at-itemid").text), ["site-01"]);
  assert.equal(gates.find("aos-at-teamtag").length, 0, "its own team is not named");
  const tabs = root.one("aos-aw-views");
  assert.equal(tabs.attrs.get("role"), "tablist");
  const tab = tabs.find("aos-aw-view");
  assert.deepEqual(tab.map((b) => b.attrs.get("data-view")), ["activity", "items", "channel", "settings"]);
  assert.deepEqual(tab.map((b) => b.one("aos-aw-viewlabel").text), ["Activity", "Items", "Channel", "Settings"]);
  assert.equal(tab[1].one("aos-aw-viewcount").text, "3");
  assert.deepEqual(tab.map((b) => b.attrs.get("aria-selected")), ["true", "false", "false", "false"]);
  assert.deepEqual(tab.map((b) => b.attrs.get("tabindex")), ["0", "-1", "-1", "-1"]);
  const panel = root.one("aos-aw-viewpane");
  assert.equal(panel.attrs.get("role"), "tabpanel");
  assert.equal(panel.find("aos-aw-event").length, activityOf(lab).length);
  tab[2].fire("click");
  assert.deepEqual(views, ["channel"]);
  // The arrow keys move along the tabs and pick the one they land on (and it takes the keyboard).
  tabs.fire("keydown", { key: "ArrowRight", target: tab[0] });
  tabs.fire("keydown", { key: "ArrowLeft", target: tab[0] });
  tabs.fire("keydown", { key: "End", target: tab[1] });
  tabs.fire("keydown", { key: "Home", target: tab[3] });
  assert.deepEqual(views, ["channel", "items", "settings", "settings", "activity"]);
  assert.ok(tab[1].focused);
});

test("team pane: the other views hold their place; a view the old tab named shows its new counterpart", async () => {
  const lab = await team("lab");
  for (const [asked, shown] of [["items", "items"], ["channel", "channel"], ["settings", "settings"], ["board", "items"], ["interact", "channel"], ["roster", "settings"], ["manage", "settings"]] as const) {
    assert.equal(teamView(asked), shown);
    const root = new El("section");
    renderTeamPane(html(root), harness(lab).c, asked, () => {});
    assert.equal(root.find("aos-aw-view").find((b) => b.attrs.get("aria-selected") === "true")?.attrs.get("data-view"), shown);
    assert.equal(root.one("aos-aw-viewpane").attrs.get("data-view"), shown);
    assert.equal(root.find("aos-aw-event").length, 0);
  }
  assert.equal(teamView("activity"), "activity");
});

test("team pane: the Activity page count is kept per team in the tab's state; older adds a page and redraws", () => {
  const t = chatty(ACTIVITY_PAGE + 5);
  const h = harness(t);
  const root = new El("section");
  renderTeamPane(html(root), h.c, "activity", () => {});
  assert.equal(root.find("aos-aw-event").length, ACTIVITY_PAGE);
  root.one("aos-aw-older").fire("click");
  assert.equal(h.ui.activityPages.get("busy"), 2);
  assert.equal(h.renders(), 1);
  const again = new El("section");
  renderTeamPane(html(again), h.c, "activity", () => {});
  assert.equal(again.find("aos-aw-event").length, ACTIVITY_PAGE + 5);
});

test("a paused team: the banner, and Resume resumes it", async () => {
  const ops = await team("ops");
  const h = harness(ops);
  const root = new El("section");
  renderTeamPane(html(root), h.c, "activity", () => {});
  const bar = root.one("aos-aw-paused");
  assert.match(bar.text, /^This team is paused: no seat can be dispatched until it resumes\./);
  bar.press(/^Resume$/);
  assert.deepEqual(h.acts.map((a) => [a.key, a.args]), [["pause:ops", ["resume", "ops"]]]);
  const busy = new El("section");
  renderTeamPane(html(busy), harness(ops, [ops], { busy: (k) => k === "pause:ops" }).c, "activity", () => {});
  const b = busy.one("aos-aw-paused").find("aos-aw-btn")[0];
  assert.equal(b.text, "Resuming…");
  assert.ok(b.disabled);
  // A running team has no banner.
  const lab = new El("section");
  renderTeamPane(html(lab), harness(await team("lab")).c, "activity", () => {});
  assert.equal(lab.find("aos-aw-paused").length, 0);
});

test("a broken team: its error card with Open TEAM.md, and nothing else", async () => {
  const broken = await team("broken");
  const h = harness(broken);
  const root = new El("section");
  renderTeamPane(html(root), h.c, "activity", () => {});
  const card = root.one("is-error");
  assert.match(card.text, /^persona\/teams\/broken\/TEAM\.md: /);
  card.press(/^Open TEAM\.md$/);
  assert.deepEqual(h.opened, ["persona/teams/broken/TEAM.md"]);
  assert.equal(root.find("aos-aw-views").length, 0);
  assert.equal(root.find("aos-aw-now").length, 0);
});

// ── Needs you (D5) ──

test("Needs you: every pending gate across teams, each card drawn for its own team, the team named when there are several", async () => {
  const teams = await fixture();
  const asked: string[] = [];
  const root = new El("section");
  renderNeeds(html(root), (t) => { asked.push(t.id); return harness(t, teams).c; }, teams);
  assert.equal(root.one("aos-aw-panetitle").text, "Needs you");
  assert.equal(root.attrs.get("aria-label"), "Needs you");
  const cards = gateCards(teams);
  assert.equal(cards.length, 3);
  const drawn = root.one("aos-aw-gates").find("aos-at-gate");
  assert.deepEqual(drawn.map((g) => g.one("aos-at-itemid").text), cards.map((c) => c.item.id));
  assert.deepEqual(drawn.map((g) => g.one("aos-at-teamtag").text), cards.map((c) => c.team.name));
  assert.deepEqual(asked, cards.map((c) => c.team.id));
  assert.equal(root.one("aos-aw-paneline").text, "3 gates waiting on you across 2 teams");

  const lab = teams.find((t) => t.id === "lab")!;
  const alone = new El("section");
  renderNeeds(html(alone), (t) => harness(t).c, [lab]);
  assert.equal(alone.find("aos-at-gate").length, 1);
  assert.equal(alone.find("aos-at-teamtag").length, 0, "one team: not named");
  assert.equal(alone.one("aos-aw-paneline").text, "1 gate waiting on you across 1 team");
});

test("Needs you: with nothing waiting, one dim line", () => {
  const quiet = chatty(1);
  const root = new El("section");
  renderNeeds(html(root), (t) => harness(t).c, [quiet]);
  assert.equal(root.find("aos-aw-gates").length, 0);
  const line = root.one("aos-aw-paneline");
  assert.equal(line.text, "Nothing waits on you.");
  assert.ok(line.cls.has("aos-aw-dim"));
});

// ── Items (D8) ──

/** Each list row as "<id> | <title> | <strip cells> | <state> | <who holds it> | <budget>". */
const itemRows = (root: El) => root.find("aos-aw-item").map((r) => [
  r.one("aos-aw-itemid").text, r.one("aos-aw-itemtitle").text,
  r.one("aos-aw-strip").find("aos-aw-seg").map((s) => [...s.cls].find((c) => c.startsWith("is-"))?.slice(3)).join(" "),
  r.one("aos-aw-itemstate").text, r.one("aos-aw-holder").text, r.one("aos-aw-money").text,
].join(" | "));

test("items: a flat list in needs-me order, each row its id, title, stage strip, state, who holds it and budget; done folded last", async () => {
  const lab = await team("lab");
  const h = harness(lab);
  const root = new El("section");
  renderItems(html(root), h.c, "list", () => {});
  assert.deepEqual(itemRows(root), [
    "site-01 | Landing page | gate todo todo todo todo | discuss gate | Lead | $3.44 / $20",
    "site-03 | Blog | done done done blocked todo | blocked | Reviewer | $19.10 / $25",
    "site-02 | Contact form | done done current todo todo | working | Builder · claude · 10m | $8.20 / $30",
  ]);
  const first = root.find("aos-aw-item")[0];
  assert.equal(first.attrs.get("role"), "button");
  assert.equal(first.attrs.get("tabindex"), "0");
  assert.equal(first.attrs.get("aria-expanded"), "false");
  assert.equal(first.attrs.get("aria-label"), "site-01: Landing page, discuss gate");
  assert.ok(first.one("aos-aw-itemstate").cls.has("is-gate"));
  // The strip names each stage's state for a reader that cannot see its colours.
  assert.equal(first.one("aos-aw-strip").attrs.get("aria-label"), "discuss: gate waiting on you, plan: to do, execute: to do, verify: to do, ship: to do");
  assert.equal(first.one("aos-aw-strip").find("aos-aw-seg")[0].attrs.get("title"), "discuss: gate waiting on you");
  // A live run names who holds it, on which provider, for how long.
  const live = root.find("aos-aw-item")[2].one("aos-aw-live");
  assert.equal(live.attrs.get("title"), "running now: lab-site-02-builder-c, started 2026-09-20T12:50:00.000Z");
  // The done item waits behind its toggle, as the board's done toggle.
  const tog = root.one("aos-aw-donetoggle");
  assert.equal(tog.text, "1 done");
  assert.equal(tog.attrs.get("aria-expanded"), "false");
  tog.fire("click");
  assert.ok(h.ui.showDone.has("list:lab"));
  assert.equal(h.renders(), 1);
  const shown = new El("section");
  renderItems(html(shown), h.c, "list", () => {});
  assert.equal(shown.one("aos-aw-donetoggle").text, "hide 1 done");
  assert.deepEqual(itemRows(shown).slice(3), ["site-00 | Scaffold | done done done done done | done | – | $14.50 / $20"]);
  assert.ok(shown.find("aos-aw-item")[3].cls.has("is-done"));
  shown.one("aos-aw-donetoggle").fire("click");
  assert.ok(!h.ui.showDone.has("list:lab"));
});

test("items: a row opens the item's detail below, Enter does too, and a second click closes it", async () => {
  const lab = await team("lab");
  const h = harness(lab);
  const root = new El("section");
  renderItems(html(root), h.c, "list", () => {});
  assert.equal(root.find("aos-at-detail").length, 0);
  root.find("aos-aw-item")[1].fire("click");
  assert.equal(h.c.ui.openItem, "site-03");
  assert.equal(h.renders(), 1);

  const open = new El("section");
  renderItems(html(open), h.c, "list", () => {});
  const row = open.find("aos-aw-item")[1];
  assert.ok(row.cls.has("is-open"));
  assert.equal(row.attrs.get("aria-expanded"), "true");
  // The detail is today's: facts, the budget editor of an open item, the latest posts, its runs; it sits after the list.
  const d = open.one("aos-at-detail");
  assert.ok(open.kids.indexOf(d) > open.kids.indexOf(open.one("aos-aw-items")), "the detail is below the list");
  assert.equal(d.one("aos-at-detailtitle").text, "Blog");
  assert.deepEqual(d.one("aos-at-facts").kids.filter((x) => x.tag === "dd").map((x) => x.text).slice(0, 3), ["verify · blocked", "Reviewer", "$19.10 spent of $25 · 3 Codex runs"]);
  assert.equal(d.find("aos-at-budget").length, 1);
  assert.equal(d.one("aos-at-posts").find("aos-at-post").length, 1);
  assert.equal(d.one("aos-at-runs").find("aos-inv-row").length, 1);
  // Its posts link goes to the Channel, filtered to the item.
  d.press(/^All posts on this item in Channel$/);
  assert.equal(h.c.ui.channelItem, "site-03");
  assert.deepEqual(h.selects, [["lab", "channel", undefined]]);
  row.fire("click");
  assert.equal(h.c.ui.openItem, null);
  open.find("aos-aw-item")[0].fire("keydown", { key: "Enter" });
  assert.equal(h.c.ui.openItem, "site-01");
  // A pending gate's detail carries its gate card, whose item link lands on Items with the item open.
  const gated = new El("section");
  renderItems(html(gated), h.c, "list", () => {});
  const card = gated.one("aos-at-detail").one("aos-at-gate");
  card.one("aos-at-itemid").fire("click");
  assert.deepEqual(h.selects.at(-1), ["lab", "items", "site-01"]);
});

test("items: the item ui.openItem names shows its detail, a done one folded or not, in list and board mode", async () => {
  const lab = await team("lab");
  const h = harness(lab);
  h.c.ui.openItem = "site-00";
  const list = new El("section");
  renderItems(html(list), h.c, "list", () => {});
  assert.equal(list.find("aos-aw-item").length, 3, "the done item stays folded");
  assert.equal(list.one("aos-at-detail").one("aos-at-detailtitle").text, "Scaffold");
  const board = new El("section");
  renderItems(html(board), h.c, "board", () => {});
  assert.equal(board.one("aos-at-detail").one("aos-at-detailtitle").text, "Scaffold");
  // An id no longer on the board shows no detail.
  h.c.ui.openItem = "gone-01";
  const none = new El("section");
  renderItems(html(none), h.c, "list", () => {});
  assert.equal(none.find("aos-at-detail").length, 0);
});

test("items: board mode is today's board, one column per stage; a card opens the same detail", async () => {
  const lab = await team("lab");
  const h = harness(lab);
  const root = new El("section");
  renderItems(html(root), h.c, "board", () => {});
  assert.equal(root.find("aos-aw-items").length, 0);
  assert.deepEqual(root.find("aos-at-colhead").map((c) => c.kids[0].text), ["DISCUSS", "PLAN", "EXECUTE", "VERIFY", "SHIP"]);
  root.find("aos-at-card").find((c) => c.one("aos-at-itemid").text === "site-02")!.fire("click");
  assert.equal(h.c.ui.openItem, "site-02");
});

test("items: an item whose gate is not pending is an ordinary open item, ranked with the open ones", () => {
  const row = (o: Record<string, unknown>) => JSON.stringify({ schema: 1, ts: "2026-09-20T10:00:00.000Z", by: "lead", stage: "plan", owner: "lead", budget: { usd: 5, spentUsd: 1 }, ...o });
  const t = teamFrom({
    id: "mix", disabled: false, markers: [], state: null, runs: null, channel: null,
    board: [
      row({ id: "a-01", title: "Paused one", status: "paused" }),
      row({ id: "a-02", title: "Decided gate", status: "gate", gate: { name: "plan", state: "approved", by: "user" } }),
      row({ id: "a-03", title: "Working one", status: "working" }),
    ].join("\n") + "\n",
    teamMd: "---\nid: mix\nname: Mix\nlead: lead\nmembers:\n  - id: lead\n    name: Lead\n    agent: team-lead\n---\n",
  });
  const root = new El("section");
  renderItems(html(root), harness(t).c, "list", () => {});
  assert.deepEqual(itemRows(root), [
    "a-03 | Working one | done current todo todo todo | working | Lead | $1 / $5",
    "a-02 | Decided gate | done current todo todo todo | open | Lead | $1 / $5",
    "a-01 | Paused one | done current todo todo todo | paused | Lead | $1 / $5",
  ]);
  assert.ok(root.find("aos-aw-item")[1].one("aos-aw-itemstate").cls.has("is-neutral"));
  assert.equal(root.find("aos-aw-donetoggle").length, 0, "nothing done, no toggle");
});

test("items: an empty board says how items arrive, in list and board mode", () => {
  const quiet = chatty(1);
  const list = new El("section");
  renderItems(html(list), harness(quiet).c, "list", () => {});
  assert.equal(list.find("aos-aw-item").length, 0);
  assert.equal(list.one("aos-aw-empty").text, "No work items yet. The lead adds them with aos team put: tell Lead what to build in Channel.");
  const board = new El("section");
  renderItems(html(board), harness(quiet).c, "board", () => {});
  assert.equal(board.one("aos-at-emptyline").text, "No work items yet. The lead adds them with aos team put: tell Lead what to build in Channel.");
});

test("team pane: Items has the list · board toggle in the view bar; a pick asks for the other mode; no toggle elsewhere", async () => {
  const lab = await team("lab");
  const modes: string[] = [];
  const root = new El("section");
  renderTeamPane(html(root), harness(lab).c, "items", () => {}, { mode: "list", onMode: (m) => modes.push(m) });
  const bar = root.one("aos-aw-viewbar");
  assert.equal(bar.find("aos-aw-views").length, 1, "the tabs are in the bar");
  const toggle = bar.one("aos-aw-itemsmode");
  assert.equal(toggle.attrs.get("role"), "group");
  assert.equal(toggle.attrs.get("aria-label"), "Show items as");
  const btns = toggle.find("aos-aw-mode");
  assert.deepEqual(btns.map((b) => b.text), ["list", "board"]);
  assert.deepEqual(btns.map((b) => b.attrs.get("aria-pressed")), ["true", "false"]);
  btns[0].fire("click");
  btns[1].fire("click");
  assert.deepEqual(modes, ["board"], "the shown mode is not asked for again");
  assert.equal(root.one("aos-aw-viewpane").find("aos-aw-items").length, 1);

  const board = new El("section");
  renderTeamPane(html(board), harness(lab).c, "items", () => {}, { mode: "board", onMode: () => {} });
  assert.deepEqual(board.one("aos-aw-itemsmode").find("aos-aw-mode").map((b) => b.attrs.get("aria-pressed")), ["false", "true"]);
  assert.equal(board.one("aos-aw-viewpane").find("aos-at-board").length, 1);

  const activity = new El("section");
  renderTeamPane(html(activity), harness(lab).c, "activity", () => {}, { mode: "board", onMode: () => {} });
  assert.equal(activity.find("aos-aw-itemsmode").length, 0);
});

// ── Channel (D9) ──

test("channel: today's Interact pane, its posts, mentions and item chips; Enter posts to the lead and keeps no draft", async () => {
  const lab = await team("lab");
  const h = harness(lab);
  const root = new El("section");
  renderTeamPane(html(root), h.c, "channel", () => {});
  const panel = root.one("aos-aw-viewpane");
  assert.equal(panel.attrs.get("data-view"), "channel");
  assert.equal(panel.one("aos-at-channel").find("aos-at-post").length, 5);
  assert.deepEqual(panel.one("aos-nt-filters").find("aos-nt-chip").map((c) => c.text), ["All", "site-03", "site-01"]);
  assert.equal(panel.find("aos-at-mention").filter((m) => m.cls.has("is-known"))[0].text, "@builder");
  const box = panel.all().find((e) => e.tag === "textarea")!;
  assert.equal(box.attrs.get("placeholder"), "Message @lead. Enter sends, Shift+Enter adds a line.");
  box.value = "Ship the landing page";
  box.fire("input");
  assert.equal(h.ui.drafts.get("lab"), "Ship the landing page");
  box.fire("keydown", { key: "Enter" });
  assert.deepEqual(h.acts.map((a) => [a.key, a.args]), [["post:lab", ["post", "lab", "--from", "user", "--kind", "note", "@lead Ship the landing page"]]]);
  await settled();
  assert.equal(h.ui.drafts.has("lab"), false);
});

// ── Settings (D10) ──

/** Your agents for Add a member: two on the lab team, one that can join, one whose file is named apart from it, a plugin's. */
const MINE = parseAgents(JSON.stringify({ schema: 1, agents: [
  { id: "team-lead", name: "team-lead", origin: { host: "claude", scope: "user" }, on: { claude: { path: "/a/agents/team-lead.md", invoke: "@agent-team-lead", run: "claude --agent team-lead" } } },
  { id: "team-builder", name: "team-builder", origin: { host: "claude", scope: "user" }, on: { claude: { path: "/a/agents/team-builder.md", invoke: "@agent-team-builder", run: "claude --agent team-builder" } } },
  { id: "scout", name: "scout", description: "Looks ahead for the next item.", origin: { host: "claude", scope: "user" }, on: { claude: { path: "/a/agents/scout.md", invoke: "@agent-scout", run: "claude --agent scout" } } },
  { id: "odd", name: "odd", origin: { host: "claude", scope: "user" }, on: { claude: { path: "/a/agents/other-name.md", invoke: "@agent-odd", run: "claude --agent odd" } } },
  { id: "kit:helper", name: "helper", origin: { host: "claude", scope: "plugin", plugin: "kit" }, on: { claude: { path: "/a/plugins/kit/agents/helper.md", invoke: "@agent-helper", run: "claude --agent helper" } } },
] }));

/** The facts list as "<term>: <value>" lines. */
const facts = (root: El) => {
  const k = root.one("aos-aw-facts").kids;
  assert.deepEqual(k.map((e) => e.tag), k.map((_, i) => (i % 2 ? "dd" : "dt")));
  return k.filter((_, i) => i % 2 === 0).map((dt, i) => `${dt.text}: ${k[2 * i + 1].text}`);
};


test("settings: lead, reports to, parent, stages, gates and the default budget, read-only; no text box", async () => {
  const lab = await team("lab");
  const ops = await team("ops");
  const root = new El("section");
  renderSettings(html(root), harness(lab, [lab, ops]).c);
  assert.deepEqual(facts(root), [
    "Lead: Lead", "Reports to: none", "Parent: none", "Stages: discuss → plan → execute → verify → ship", "Gates: discuss, ship", "Default budget: $10",
  ]);
  assert.equal(root.all().filter((e) => e.tag === "input" || e.tag === "textarea").length, 0);
  assert.match(root.one("aos-aw-sethint").text, /^From persona\/teams\/lab\/TEAM\.md\./);

  // A sub-team: who its lead reports to, by name in the parent team, and the parent as a link to its Settings.
  const h = harness(ops, [lab, ops]);
  const sub = new El("section");
  renderSettings(html(sub), h.c);
  assert.deepEqual(facts(sub), [
    "Lead: Chief", "Reports to: Lead (Lab)", "Parent: Lab", "Stages: plan → build → ship", "Gates: plan, ship", "Default budget: $5",
  ]);
  sub.press(/^Lab$/);
  assert.deepEqual(h.selects, [["lab", "settings", undefined]]);
});

test("settings: Pause and Resume the team, saying which it is; busy while it runs", async () => {
  const lab = await team("lab");
  const h = harness(lab);
  const root = new El("section");
  renderSettings(html(root), h.c);
  assert.equal(root.one("aos-aw-runstate").text, "Running: its seats can be dispatched");
  root.press(/^Pause$/);
  const ops = await team("ops");
  const p = harness(ops);
  const paused = new El("section");
  renderSettings(html(paused), p.c);
  assert.equal(paused.one("aos-aw-runstate").text, "Paused: no seat can be dispatched until it resumes");
  paused.press(/^Resume$/);
  assert.deepEqual([...h.acts, ...p.acts].map((a) => [a.key, a.args]), [["pause:lab", ["pause", "lab"]], ["pause:ops", ["resume", "ops"]]]);
  const busy = new El("section");
  renderSettings(html(busy), harness(lab, [lab], { busy: (k) => k === "pause:lab" }).c);
  const b = busy.one("aos-aw-pause");
  assert.equal(b.text, "Pausing…");
  assert.ok(b.disabled);
});

test("settings: Add a member offers your addable agents not on the team; the pick survives a redraw; Add runs member add", async () => {
  const lab = await team("lab");
  const h = harness(lab, [lab], { agents: MINE });
  const root = new El("section");
  renderSettings(html(root), h.c);
  const add = root.one("aos-aw-add");
  const sel = add.all().find((e) => e.tag === "select")!;
  assert.equal(sel.attrs.get("aria-label"), "Agent to add");
  assert.deepEqual(sel.kids.map((o) => o.text), ["pick one of your agents", "scout: Looks ahead for the next item."]);
  const btn = () => add.all().find((e) => e.tag === "button")!;
  assert.ok(btn().disabled, "nothing picked yet");
  assert.match(root.one("aos-aw-leftout").text, /^1 of your agents is left out: its file is named differently/);
  sel.value = "scout";
  sel.fire("change");
  assert.equal(h.ui.addPick.get("lab"), "scout");
  assert.ok(!btn().disabled);
  // A redraw (the clock, a sweep) keeps the pick.
  const again = new El("section");
  renderSettings(html(again), h.c);
  const add2 = again.one("aos-aw-add");
  assert.equal(add2.all().find((e) => e.tag === "select")!.value, "scout");
  const go = add2.all().find((e) => e.tag === "button")!;
  assert.ok(!go.disabled);
  go.fire("click");
  assert.deepEqual(h.acts.map((a) => [a.key, a.args]), [["add:lab", ["member", "add", "lab", "scout"]]]);
  await settled();
  assert.equal(h.ui.addPick.has("lab"), false, "an added agent's pick is dropped");

  // Every agent of yours already on the team: no picker, a line that says so.
  const onlyOurs = parseAgents(JSON.stringify({ schema: 1, agents: [
    { id: "team-lead", name: "team-lead", origin: { host: "claude", scope: "user" }, on: { claude: { path: "/a/agents/team-lead.md", invoke: "@agent-team-lead", run: "claude --agent team-lead" } } },
  ] }));
  const full = new El("section");
  renderSettings(html(full), harness(lab, [lab], { agents: onlyOurs }).c);
  assert.equal(full.one("aos-aw-add").all().filter((e) => e.tag === "select").length, 0);
  assert.match(full.one("aos-aw-add").text, /every one of your agents is on this team/);
});

test("settings: Open TEAM.md opens the team's file", async () => {
  const lab = await team("lab");
  const h = harness(lab);
  const root = new El("section");
  renderSettings(html(root), h.c);
  root.press(/^Open TEAM\.md$/);
  assert.deepEqual(h.opened, ["persona/teams/lab/TEAM.md"]);
});

test("team pane: Settings is the Settings view", async () => {
  const lab = await team("lab");
  const root = new El("section");
  renderTeamPane(html(root), harness(lab).c, "settings", () => {});
  const panel = root.one("aos-aw-viewpane");
  assert.equal(panel.attrs.get("data-view"), "settings");
  assert.equal(panel.find("aos-aw-facts").length, 1);
});
