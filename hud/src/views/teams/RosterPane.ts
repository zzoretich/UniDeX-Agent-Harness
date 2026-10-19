// RosterPane.ts — the Agent Teams tab's Roster (spec 2026-09-28-agent-teams-design §4.4): each member with its provider,
// model, what the files say it is doing (working from a live marker, blocked from the board, paused, idle), its current
// item and last run, and a "Talk to" button per enabled host; then the team's place in the tree (parent, sub-teams).
import { memberStatus, memberTone, runTone, pendingGates, usd } from "../../data/teams";
import { TeamsCtx, statusChip, providerPill, since, hostButtons, talkCommand, HOST_LABEL } from "./ui";

export function renderRoster(host: HTMLElement, ctx: TeamsCtx): void {
  const t = ctx.team;
  const table = host.createDiv({ cls: "aos-inv-table aos-at-roster" });
  if (!t.members.length) table.createDiv({ cls: "aos-inv-row aos-dim", text: "No members: add one in Manage." });
  for (const m of memberStatus(t)) {
    const row = table.createDiv({ cls: `aos-inv-row aos-at-member${m.status === "paused" ? " is-off" : ""}` });
    const who = row.createDiv({ cls: "aos-at-who" });
    const name = who.createDiv({ cls: "aos-at-name", text: m.name });
    if (m.lead) name.createSpan({ cls: "aos-pill aos-pill-dim aos-at-leadpill", text: "lead" });
    who.createDiv({ cls: "aos-dim aos-at-role", text: [m.role, m.agent ? `agent ${m.agent}` : "no agent"].filter(Boolean).join(" · ") });

    const seat = row.createDiv({ cls: "aos-at-seat" });
    providerPill(seat, m.provider);
    const model = [m.model ?? "inherit", m.effort && m.effort !== "inherit" ? m.effort : ""].filter(Boolean).join(" · ");
    seat.createSpan({ cls: "aos-dim aos-at-model", text: model, attr: { title: `model ${m.model ?? "inherit"}, effort ${m.effort ?? "inherit"}` } });

    const state = row.createDiv({ cls: "aos-at-mstate" });
    statusChip(state, memberTone(m.status), m.status);
    if (m.item) {
      const a = state.createEl("a", { cls: "aos-link aos-at-itemlink", text: m.item, href: "#", attr: { title: "show on the board" } });
      a.addEventListener("click", (e) => { e.preventDefault(); ctx.select(t.id, "board", m.item); });
    }

    const last = row.createDiv({ cls: "aos-at-last" });
    if (m.lastRun) {
      const r = m.lastRun;
      last.createSpan({ cls: `aos-at-runstatus ${runTone(r.status)}`, text: r.status });
      last.createSpan({ cls: "aos-dim", text: ` ${r.usd == null ? "" : `${usd(r.usd)} · `}${since(r.ts, ctx.now)} ago`, attr: { title: `${r.item ?? ""} ${r.ts}`.trim() } });
    } else {
      last.createSpan({ cls: "aos-dim", text: "no runs yet" });
    }

    const acts = row.createDiv({ cls: "aos-at-rowacts" });
    hostButtons(acts, ctx, "Talk", (h) => talkCommand(ctx, m.agent, h),
      (h, cmd) => `Talk to ${m.name}: starts a ${HOST_LABEL[h]} session as its agent: ${cmd}`, undefined, { quiet: true });
  }

  const parent = t.parent ? ctx.teams.find((x) => x.id === t.parent) : null;
  const kids = ctx.teams.filter((x) => x.parent === t.id && x.id !== t.id);
  if (parent || kids.length || t.reportsTo) {
    host.createDiv({ cls: "aos-rt-subhead aos-dim", text: "IN THE TREE" });
    const tree = host.createDiv({ cls: "aos-at-tree" });
    if (parent) {
      const p = tree.createDiv({ cls: "aos-at-treerow" });
      p.createSpan({ cls: "aos-dim", text: "part of " });
      const a = p.createEl("a", { cls: "aos-link", text: parent.name, href: "#" });
      a.addEventListener("click", (e) => { e.preventDefault(); ctx.select(parent.id, "roster"); });
    }
    if (t.reportsTo) tree.createDiv({ cls: "aos-at-treerow aos-dim", text: `${t.members.find((m) => m.id === t.lead)?.name ?? t.lead} reports to ${t.reportsTo}` });
    for (const k of kids) {
      const r = tree.createDiv({ cls: "aos-at-treerow" });
      r.createSpan({ cls: "aos-dim", text: "└ " });
      const a = r.createEl("a", { cls: "aos-link", text: k.name, href: "#" });
      a.addEventListener("click", (e) => { e.preventDefault(); ctx.select(k.id, "roster"); });
      const g = k.error ? 0 : pendingGates(k).length;
      r.createSpan({ cls: "aos-dim", text: k.error ? ` · unreadable ${k.errorFile ?? "TEAM.md"}` : ` · lead ${k.lead} · ${k.members.length} members${g ? ` · ${g} gate${g === 1 ? "" : "s"} waiting` : ""}` });
    }
  }
}
