// SettingsPane.ts — a team's Settings (spec 2026-11-12-agent-workspace-design D10): what TEAM.md says of the team, read
// only (lead, reports to, parent, stages, gates, the default budget: `aos team set` changes only a seat's provider, model
// and effort), then Pause / Resume (`aos team pause|resume`), Add a member (a picker of your agents that `member add`
// can find and that are not on this team) and Open TEAM.md. Every control is a picker or a button, never a text box
// (ui/noTextBoxes.test.ts scans this file). Each change is one `aos team` call; its file events redraw the pane.
import { groupAgents, addable } from "../../data/agents";
import { TEAMS_DIR, usd } from "../../data/teams";
import { pauseArgs, addMemberArgs } from "../../data/teamWriter";
import { TeamsCtx, errorLine } from "../teams/ui";

export function renderSettings(host: HTMLElement, ctx: TeamsCtx): void {
  const t = ctx.team;
  const box = host.createDiv({ cls: "aos-aw-settings" });
  facts(box, ctx);
  box.createDiv({
    cls: "aos-aw-sethint aos-aw-dim",
    text: `From ${TEAMS_DIR}/${t.id}/TEAM.md. A seat's provider, model and effort change in its agent's profile; the rest is edited in the file.`,
  });
  runState(box, ctx);
  addMember(box, ctx);
  const open = box.createDiv({ cls: "aos-aw-setrow" });
  const file = `${TEAMS_DIR}/${t.id}/TEAM.md`;
  const b = open.createEl("button", { cls: "aos-aw-btn", text: "Open TEAM.md", attr: { type: "button", title: `Open ${file}`, "data-focus": "settings:open" } });
  b.addEventListener("click", () => ctx.openFile(file));
}

/** The team-level keys of TEAM.md, as a definition list. */
function facts(host: HTMLElement, ctx: TeamsCtx): void {
  const t = ctx.team;
  const dl = host.createEl("dl", { cls: "aos-aw-facts" });
  const fact = (k: string) => { dl.createEl("dt", { text: k }); return dl.createEl("dd"); };
  fact("Lead").setText(t.members.find((m) => m.id === t.lead)?.name ?? (t.lead || "none"));
  // reportsTo names a member of the parent team (its lead, as a rule): by name when the parent lists it.
  const parent = t.parent ? ctx.teams.find((x) => x.id === t.parent) ?? null : null;
  const boss = t.reportsTo ? parent?.members.find((m) => m.id === t.reportsTo) : undefined;
  fact("Reports to").setText(!t.reportsTo ? "none" : boss ? `${boss.name} (${parent!.name || parent!.id})` : t.reportsTo);
  const p = fact("Parent");
  if (!t.parent) p.setText("none");
  else if (!parent) p.setText(`${t.parent} (not found)`);
  else {
    const a = p.createEl("a", { cls: "aos-aw-link", text: parent.name || parent.id, href: "#", attr: { title: `Show ${parent.name || parent.id}'s settings` } });
    a.addEventListener("click", (e) => { e.preventDefault(); ctx.select(parent.id, "settings"); });
  }
  fact("Stages").setText(t.stages.join(" → "));
  fact("Gates").setText(t.gates.length ? t.gates.join(", ") : "none");
  fact("Default budget").setText(usd(t.budgetDefault));
}

/** Running or paused, and the button that flips it (`aos team pause|resume`). */
function runState(host: HTMLElement, ctx: TeamsCtx): void {
  const t = ctx.team;
  const k = `pause:${t.id}`;
  const busy = ctx.busy(k);
  const row = host.createDiv({ cls: "aos-aw-setrow" });
  row.createSpan({
    cls: `aos-aw-runstate${t.disabled ? " is-paused" : ""}`,
    text: t.disabled ? "Paused: no seat can be dispatched until it resumes" : "Running: its seats can be dispatched",
  });
  const b = row.createEl("button", {
    cls: "aos-aw-btn aos-aw-pause", text: busy ? (t.disabled ? "Resuming…" : "Pausing…") : t.disabled ? "Resume" : "Pause",
    attr: { type: "button", "data-focus": "settings:pause", title: t.disabled ? "aos team resume: its seats can be dispatched again" : "aos team pause: no seat of this team is dispatched until it resumes" },
  });
  b.disabled = busy;
  b.addEventListener("click", () => void ctx.act(k, pauseArgs(t.id, !t.disabled)));
  // While the team is paused the pane's banner, which shares this key, shows the error.
  if (!t.disabled) errorLine(host, ctx.error(k));
}

/** Add a member: one of your agents that `member add` can find (addable) and that is not on this team. The pick survives
 *  a redraw (a file event, the tab's clock, the runtime's sweep) until it is added. */
function addMember(host: HTMLElement, ctx: TeamsCtx): void {
  const t = ctx.team;
  const key = `add:${t.id}`;
  const busy = ctx.busy(key);
  const taken = new Set(t.members.map((m) => m.agent).filter(Boolean));
  const mine = groupAgents(ctx.agents.agents).yours.filter((a) => !taken.has(a.id));
  const free = mine.filter(addable).sort((a, b) => a.name.localeCompare(b.name));
  const left = mine.length - free.length;
  const row = host.createDiv({ cls: "aos-aw-add" });
  row.createSpan({ cls: "aos-aw-setlabel", text: "Add a member" });
  // Such an agent could join by its file name, but a Claude seat runs `claude --agent <that name>`, which Claude Code
  // resolves by the agent's declared name, so the seat would not start: renaming the file is the fix.
  const leftOut = () => {
    if (left) host.createDiv({ cls: "aos-aw-leftout aos-aw-dim", text: `${left} of your agents ${left === 1 ? "is" : "are"} left out: ${left === 1 ? "its file is" : "their files are"} named differently from the agent's name, and a seat runs an agent by both. Rename the file to <name>.md (or .toml) to add it.` });
  };
  if (!free.length) {
    row.createSpan({ cls: "aos-aw-dim", text: !ctx.agents.agents.length ? "no agents listed yet: create one, then sync now" : mine.length ? "none of your agents can be added here" : "every one of your agents is on this team" });
    leftOut();
    errorLine(host, ctx.error(key));
    return;
  }
  const sel = row.createEl("select", { cls: "dropdown", attr: { "aria-label": "Agent to add", "data-focus": "settings:add-pick" } });
  sel.createEl("option", { value: "", text: "pick one of your agents" });
  for (const a of free) sel.createEl("option", { value: a.id, text: a.description ? `${a.name}: ${a.description.slice(0, 60)}` : a.name });
  const picked = ctx.ui.addPick.get(t.id);
  if (picked && free.some((a) => a.id === picked)) sel.value = picked;
  sel.disabled = busy;
  const add = row.createEl("button", { cls: "aos-aw-btn", text: busy ? "Adding…" : "Add", attr: { type: "button", "data-focus": "settings:add" } });
  add.disabled = busy || !sel.value;
  sel.addEventListener("change", () => {
    if (sel.value) ctx.ui.addPick.set(t.id, sel.value); else ctx.ui.addPick.delete(t.id);
    add.disabled = busy || !sel.value;
  });
  add.addEventListener("click", () => {
    if (sel.value) void ctx.act(key, addMemberArgs(t.id, sel.value)).then((ok) => { if (ok) ctx.ui.addPick.delete(t.id); });
  });
  row.createSpan({ cls: "aos-aw-dim aos-aw-addhint", text: "joins as a Member on every stage, on the host that has the agent; set its seat in its profile" });
  leftOut();
  errorLine(host, ctx.error(key));
}
