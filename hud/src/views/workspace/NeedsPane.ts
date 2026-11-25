// NeedsPane.ts — the Agent Workspace's Needs you node (spec 2026-11-12-agent-workspace-design D5): today's NEEDS YOU strip
// as a pane of its own, every pending gate card across teams, each drawn by renderGateCard unchanged (presets, − / +,
// Approve asks first and opens the lead, Redirect ❯_) with the ctx of the card's own team.
import { Team, gateCards } from "../../data/teams";
import { TeamsCtx } from "../teams/ui";
import { renderGateCard } from "../teams/BoardPane";

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

export function renderNeeds(host: HTMLElement, ctxFor: (t: Team) => TeamsCtx, teams: Team[]): void {
  host.setAttr("aria-label", "Needs you");
  host.createEl("h2", { cls: "aos-aw-panetitle", text: "Needs you" });
  const cards = gateCards(teams);
  // The tour's Needs you step (agent-workspace D18) points at the gates, or at the line that says there are none.
  if (!cards.length) {
    host.createDiv({ cls: "aos-aw-paneline aos-aw-dim", text: "Nothing waits on you.", attr: { "data-tour": "agent-workspace-needs" } });
    return;
  }
  host.createDiv({ cls: "aos-aw-paneline", text: `${plural(cards.length, "gate")} waiting on you across ${plural(new Set(cards.map((c) => c.team.id)).size, "team")}` });
  const list = host.createEl("section", { cls: "aos-aw-gates", attr: { "aria-label": "Gates waiting on you", "data-tour": "agent-workspace-needs" } });
  for (const c of cards) renderGateCard(list, ctxFor(c.team), c, { showTeam: teams.length > 1 });
}
