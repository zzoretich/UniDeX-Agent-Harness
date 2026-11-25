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
    render: () => { renders++; }, select: () => {}, openFile: (p: string) => { opened.push(p); },
  } as unknown as TeamsCtx;
  return { c, ui, acts, terms, opened, renders: () => renders };
}

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
