import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAgents } from "../../data/agents";
import { Team, BoardItem, teamFrom, teamCommand, envPrefix, redirectPrompt, nextStepPrompt, isBudgetGate, expectOf, shq } from "../../data/teams";
import type { SessionHost } from "../../data/aosConfig";
import { TeamsCtx, Confirm, redirectCommand, talkCommand, nextStepCommand, since, postTime } from "./ui";
import { addable } from "./ManagePane";
import { renderGateCard, renderBoard } from "./BoardPane";

// Host parity for the tab's terminal buttons (spec 2026-09-28-agent-teams-design §5): each enabled host gets its own
// command, and a Redirect still reaches a session that can record it when the lead's agent is missing on that host.
const TEAM = teamFrom({
  id: "lab", disabled: false, markers: [], state: null, channel: null, runs: null,
  teamMd: "---\nid: lab\nlead: lead\ngates: [discuss]\nmembers:\n  - id: lead\n    agent: team-lead\n  - id: builder\n    agent: team-builder\n---\n",
  board: JSON.stringify({ id: "site-01", title: "Landing page", stage: "discuss", status: "gate", gate: { name: "discuss", state: "pending" }, ts: "2026-09-20T12:45:00.000Z" }) + "\n",
});
const IT = TEAM.board[0];

function ctx(agents: unknown[]): TeamsCtx {
  return { agents: parseAgents(JSON.stringify({ schema: 1, agents })), hosts: ["codex"], teamCmd: "aos team", hostEnv: { claude: "", codex: "" } } as unknown as TeamsCtx;
}
const LEAD_BOTH = { id: "team-lead", name: "team-lead", on: {
  claude: { invoke: "@agent-team-lead", run: "claude --agent team-lead" },
  codex: { invoke: "team-lead", run: "codex 'Use the team-lead agent. Ask me what it should work on.'" },
} };

test("Codex: Redirect asks for the lead's agent by name, with the gate and the exact record line", () => {
  const cmd = redirectCommand(ctx([LEAD_BOTH]), TEAM, IT, "codex");
  assert.match(cmd, /^codex 'Use the team-lead agent for this\. The user is redirecting the Discuss gate on site-01 \(Landing page\) in the lab team\./);
  assert.ok(cmd.endsWith(shq(`Use the team-lead agent for this. ${redirectPrompt(TEAM, IT)}`)));
  assert.ok(redirectPrompt(TEAM, IT).includes(`aos team gate redirect 'lab' 'site-01' --expect ${shq(expectOf(IT))} --note`));
  assert.match(redirectCommand(ctx([LEAD_BOTH]), TEAM, IT, "claude"), /^claude --agent team-lead 'The user is redirecting/);
});

test("a host without the lead's agent still gets a Redirect: a plain session with the same prompt", () => {
  const claudeOnly = { ...LEAD_BOTH, on: { claude: LEAD_BOTH.on.claude } };
  assert.match(redirectCommand(ctx([claudeOnly]), TEAM, IT, "codex"), /^codex 'The user is redirecting the Discuss gate on site-01/);
  assert.match(redirectCommand(ctx([]), TEAM, IT, "claude"), /^claude 'The user is redirecting/);
});

test("Talk has no fallback: a member whose agent a host lacks gets no button there", () => {
  assert.equal(talkCommand(ctx([LEAD_BOTH]), "team-builder", "codex"), null);
  assert.equal(talkCommand(ctx([LEAD_BOTH]), "team-lead", "codex"), LEAD_BOTH.on.codex.run);
});

test("ages and post times", () => {
  const now = new Date("2026-09-28T12:00:00.000Z");
  assert.deepEqual([since("2026-09-28T11:48:00.000Z", now), since("2026-09-28T09:00:00.000Z", now), since("2026-09-20T12:00:00.000Z", now), since(null, now)], ["12m", "3h", "8d", "?"]);
  // Local time, as the tab shows it: in UTC+14 that post is already on the 21st.
  const then = new Date("2026-09-20T12:00:00.000Z");
  const day = `${String(then.getMonth() + 1).padStart(2, "0")}-${String(then.getDate()).padStart(2, "0")}`;
  assert.match(postTime(then.toISOString(), now), new RegExp(`^${day} \\d\\d:\\d\\d$`));
  assert.match(postTime(now.toISOString(), now), /^\d\d:\d\d$/);
});

test("Add a member offers only agents member add can find: its file carries the agent's name", () => {
  const [a, b, c] = parseAgents(JSON.stringify({ schema: 1, agents: [
    { id: "team-scout", name: "team-scout", origin: { host: "claude", scope: "user", path: "/x/agents/team-scout.md" }, on: { claude: { invoke: "@agent-team-scout", path: "/x/agents/team-scout.md", run: "claude --agent team-scout" } } },
    { id: "reviewer", name: "reviewer", origin: { host: "claude", scope: "user", path: "/x/agents/my-reviewer.md" }, on: { claude: { invoke: "@agent-reviewer", path: "/x/agents/my-reviewer.md", run: "claude --agent reviewer" } } },
    { id: "ops-bot", name: "ops-bot", origin: { host: "codex", scope: "user", path: "/y/agents/ops-bot.toml" }, on: { codex: { invoke: "ops-bot", path: "/y/agents/ops-bot.toml", run: "codex 'Use the ops-bot agent.'" } } },
  ] })).agents;
  assert.deepEqual([addable(a), addable(b), addable(c)], [true, false, true]);
});

test("a session records into the vault the tab shows, with each host's folder the plugin uses", () => {
  assert.equal(teamCommand("/v/two", "/opt/node"), "AOS_VAULT='/v/two' '/opt/node' '/v/two/brain/scripts/team.js'", "never the terminal's own aos config");
  assert.equal(envPrefix("CLAUDE_CONFIG_DIR", "/h/.claude", "/h/.claude/"), "");
  assert.equal(envPrefix("CLAUDE_CONFIG_DIR", "/h/work-claude", "/h/.claude"), "CLAUDE_CONFIG_DIR='/h/work-claude' ");
  assert.equal(envPrefix("CODEX_HOME", "/h/work-codex", "/h/.codex"), "CODEX_HOME='/h/work-codex' ");
  const c = { ...ctx([LEAD_BOTH]), hosts: ["claude", "codex"], teamCmd: teamCommand("/v/two", "/opt/node"),
    hostEnv: { claude: "CLAUDE_CONFIG_DIR='/h/work-claude' ", codex: "CODEX_HOME='/h/work-codex' " } } as TeamsCtx;
  const prompt = redirectPrompt(TEAM, IT, c.teamCmd);
  assert.ok(prompt.includes("AOS_VAULT='/v/two' '/opt/node' '/v/two/brain/scripts/team.js' gate redirect 'lab' 'site-01'"));
  assert.equal(redirectCommand(c, TEAM, IT, "claude"), `CLAUDE_CONFIG_DIR='/h/work-claude' claude --agent team-lead ${shq(prompt)}`);
  assert.equal(redirectCommand(c, TEAM, IT, "codex"), `CODEX_HOME='/h/work-codex' codex ${shq(`Use the team-lead agent for this. ${prompt}`)}`);
  assert.equal(talkCommand(c, "team-lead", "claude"), "CLAUDE_CONFIG_DIR='/h/work-claude' claude --agent team-lead");
  assert.equal(talkCommand(c, "team-lead", "codex"), `CODEX_HOME='/h/work-codex' ${LEAD_BOTH.on.codex.run}`);
  assert.equal(redirectCommand({ ...c, agents: parseAgents("{}") } as TeamsCtx, TEAM, IT, "codex"), `CODEX_HOME='/h/work-codex' codex ${shq(prompt)}`);
});

// ── after a decision the tab records, the lead takes the next step (D10: the tab never picks a seat) ──

const withLead = (t: Team, provider: string | null): Team => ({ ...t, members: t.members.map((m) => (m.id === t.lead ? { ...m, provider } : m)) });

test("next step: the lead's own provider first, else the first enabled host with its agent, else a plain session there", () => {
  const onCodex = withLead(TEAM, "codex");
  const p = nextStepPrompt(onCodex, IT, "approved", 40);
  const both = { ...ctx([LEAD_BOTH]), hosts: ["claude", "codex"] } as TeamsCtx;
  assert.deepEqual(nextStepCommand(both, onCodex, p), { host: "codex", command: `codex ${shq(`Use the team-lead agent for this. ${p}`)}`, plain: false });
  assert.equal(nextStepCommand(both, TEAM, p)?.host, "claude", "no provider named: the first enabled host");
  assert.equal(nextStepCommand({ ...both, hosts: ["claude"] }, onCodex, p)?.command, `claude --agent team-lead ${shq(p)}`, "its own host is off");
  const claudeOnly = { ...LEAD_BOTH, on: { claude: LEAD_BOTH.on.claude } };
  assert.deepEqual(nextStepCommand({ ...both, agents: ctx([claudeOnly]).agents }, onCodex, p), { host: "claude", command: `claude --agent team-lead ${shq(p)}`, plain: false }, "its host lacks the agent");
  // No host has the agent: a plain session, told which lead to act as and where the team's rules are.
  const none = { ...both, agents: parseAgents("{}"), hostEnv: { claude: "", codex: "CODEX_HOME='/h/work-codex' " } } as TeamsCtx;
  const role = "Act as lead (lead), the lead of the lab team: its agent, team-lead, is not installed for this host, so read the team's rules in persona/teams/lab/TEAM.md first. ";
  assert.deepEqual(nextStepCommand(none, onCodex, p), { host: "codex", command: `CODEX_HOME='/h/work-codex' codex ${shq(role + p)}`, plain: true });
  const noAgent = { ...onCodex, members: onCodex.members.map((m) => (m.id === "lead" ? { ...m, agent: null } : m)) };
  assert.ok(nextStepCommand(both, noAgent, p)!.command.startsWith(`codex 'Act as lead (lead), the lead of the lab team: read the team'\\''s rules in`), "a lead with no agent at all");
  assert.equal(nextStepCommand({ ...both, hosts: [] }, onCodex, p), null);
});

/** Just enough of Obsidian's DOM helpers to render a pane and press its buttons. */
class FakeEl {
  kids: FakeEl[] = [];
  text: string;
  disabled = false;
  private on = new Map<string, ((e: unknown) => void)[]>();
  constructor(o: { text?: string } = {}) { this.text = o.text ?? ""; }
  createDiv(o?: { text?: string }): FakeEl { return this.add(o); }
  createSpan(o?: { text?: string }): FakeEl { return this.add(o); }
  createEl(_tag: string, o?: { text?: string }): FakeEl { return this.add(o); }
  appendText(s: string): void { this.text += s; }
  addEventListener(ev: string, fn: (e: unknown) => void): void { this.on.set(ev, [...(this.on.get(ev) ?? []), fn]); }
  all(): FakeEl[] { return [this, ...this.kids.flatMap((k) => k.all())]; }
  press(label: RegExp): void {
    const b = this.all().find((e) => label.test(e.text));
    assert.ok(b && !b.disabled, `no enabled ${label}`);
    for (const fn of b.on.get("click") ?? []) fn({ preventDefault() {}, stopPropagation() {} });
  }
  private add(o?: { text?: string }): FakeEl { const e = new FakeEl(o); this.kids.push(e); return e; }
}

function pane(t: Team, recorded: boolean, hosts: SessionHost[] = ["claude"]) {
  const acts: { args: string[]; confirm?: Confirm }[] = [];
  const opened: string[] = [];
  const c = {
    ...ctx([LEAD_BOTH]), teams: [t], team: t, hosts, now: new Date("2026-09-28T12:00:00.000Z"),
    ui: { team: t.id, view: "board", gateUsd: new Map(), budgetUsd: new Map(), openItem: null, showDone: new Set(), channelItem: null, drafts: new Map(), addPick: new Map() },
    busy: () => false, error: () => null, render: () => {}, select: () => {},
    act: async (_k: string, args: string[], confirm?: Confirm) => { acts.push({ args, confirm }); return recorded; },
    term: (cmd: string) => { opened.push(cmd); },
  } as unknown as TeamsCtx;
  return { c, acts, opened, root: new FakeEl() };
}
const settle = () => new Promise((r) => setImmediate(r));

test("Approve opens the lead to take the next step, only once the gate is recorded", async () => {
  const it: BoardItem = { ...IT, budget: { usd: 40, spentUsd: 3.44, codexRuns: 0 } };
  for (const recorded of [true, false]) {
    const { c, acts, opened, root } = pane(TEAM, recorded);
    renderGateCard(root as unknown as HTMLElement, c, { team: TEAM, item: it, since: null, pitch: null, budget: isBudgetGate(TEAM, it) }, { showTeam: false });
    root.press(/^Approve · \$40$/);
    await settle();
    assert.deepEqual(acts[0].args.slice(0, 4), ["gate", "approve", "lab", "site-01"]);
    assert.match(acts[0].confirm!.message, /takes the next step with a \$40 phase budget \(\$3\.44 spent so far\)\. \S+ opens in Claude Code to take it\.$/);
    assert.deepEqual(opened, recorded ? [`claude --agent team-lead ${shq(nextStepPrompt(TEAM, it, "approved", 40))}`] : [], recorded ? "the lead opens" : "a refused write opens nothing");
  }
  const { c, acts, root } = pane(TEAM, true, []);
  renderGateCard(root as unknown as HTMLElement, c, { team: TEAM, item: it, since: null, pitch: null, budget: true }, { showTeam: false });
  root.press(/^Approve/);
  await settle();
  assert.match(acts[0].confirm!.message, /Enable Claude Code or Codex, or start \S+ yourself to take it\.$/, "no host: the dialog says so");
  const plain = pane(TEAM, true, ["codex"]);
  plain.c.agents = parseAgents("{}");
  renderGateCard(plain.root as unknown as HTMLElement, plain.c, { team: TEAM, item: it, since: null, pitch: null, budget: true }, { showTeam: false });
  plain.root.press(/^Approve/);
  await settle();
  assert.match(plain.acts[0].confirm!.message, /No enabled host has lead's agent, so a plain Codex session opens as lead to take it\.$/);
  assert.match(plain.opened[0], /^codex 'Act as lead \(lead\), the lead of the lab team:/);
});

test("a raised budget on a paused item opens the lead; on a working item, or refused, it opens nothing", async () => {
  const paused: BoardItem = { ...IT, stage: "execute", status: "paused", gate: null, budget: { usd: 20, spentUsd: 20, codexRuns: 0 }, raw: { ...IT.raw, stage: "execute", status: "paused", gate: null } };
  for (const [item, recorded, opens] of [[paused, true, true], [paused, false, false], [{ ...paused, status: "working" }, true, false]] as const) {
    const t = { ...TEAM, board: [item] };
    const { c, acts, opened, root } = pane(t, recorded, ["codex"]);
    c.ui.openItem = item.id;
    c.ui.budgetUsd.set("lab/site-01", 30);
    renderBoard(root as unknown as HTMLElement, c);
    root.press(/^Set to \$30$/);
    await settle();
    assert.deepEqual(acts[0].args.slice(0, 4), ["budget", "lab", "site-01", "30"]);
    assert.deepEqual(opened, opens ? [`codex ${shq(`Use the team-lead agent for this. ${nextStepPrompt(t, item, "raised", 30)}`)}`] : []);
    assert.equal(root.all().some((e) => /opens \S+ to take the next step$/.test(e.text)), item.status === "paused", "the hint says the lead opens");
  }
});
