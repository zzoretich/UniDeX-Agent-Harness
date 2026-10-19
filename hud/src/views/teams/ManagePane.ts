// ManagePane.ts — the Agent Teams tab's Manage area (spec 2026-09-28-agent-teams-design §4.4, D4, D12). Every control is
// a picker, a switch or a button, never a text box (ui/noTextBoxes.test.ts scans this file): provider, model and effort
// offer only the presets `aos team set` accepts, which `aos team list --json` names; a member is added by picking one of
// the user's own agents, and removed after a confirm. Each change is one `aos team` call that rewrites TEAM.md.
import { groupAgents, AgentRow } from "../../data/agents";
import { Member } from "../../data/teams";
import { setArgs, pauseArgs, addMemberArgs, removeMemberArgs, modelChoices, ignoredModel } from "../../data/teamWriter";
import { TeamsCtx, errorLine } from "./ui";

type SetKey = "provider" | "model" | "effort";
const KEYS: { key: SetKey; label: string }[] = [{ key: "provider", label: "Provider" }, { key: "model", label: "Model" }, { key: "effort", label: "Effort" }];

export function renderManage(host: HTMLElement, ctx: TeamsCtx): void {
  const t = ctx.team;
  const p = ctx.presets;
  if (!p) host.createDiv({ cls: "aos-rt-banner", text: `This vault's runtime does not name the seat presets yet: run aos upgrade. Until then, change a seat with aos team set ${t.id} <member> provider|model|effort <preset>.` });

  const top = host.createDiv({ cls: "aos-at-manage-top" });
  switchChip(top, ctx, `pause:${t.id}`, t.disabled ? "Team paused" : "Team running", !t.disabled,
    (on) => pauseArgs(t.id, !on), "Paused, no seat of this team can be dispatched (persona/teams/<id>/DISABLED)");
  errorLine(host, ctx.error(`pause:${t.id}`));

  const table = host.createDiv({ cls: "aos-inv-table aos-at-manage" });
  for (const m of t.members) memberRow(table, ctx, m, p);

  addMember(host, ctx);
  host.createDiv({ cls: "aos-dim aos-at-hint", text: `Each change rewrites persona/teams/${t.id}/TEAM.md through aos team. A run already going keeps the settings it started with.` });
}

function memberRow(table: HTMLElement, ctx: TeamsCtx, m: Member, p: TeamsCtx["presets"]): void {
  const t = ctx.team;
  const lead = m.id === t.lead;
  const row = table.createDiv({ cls: `aos-inv-row aos-at-mrow${m.paused ? " is-off" : ""}` });
  const who = row.createDiv({ cls: "aos-at-who" });
  const name = who.createDiv({ cls: "aos-at-name", text: m.name });
  if (lead) name.createSpan({ cls: "aos-pill aos-pill-dim aos-at-leadpill", text: "lead" });
  who.createDiv({ cls: "aos-dim aos-at-role", text: m.role || m.id });

  const picks = row.createDiv({ cls: "aos-at-picks" });
  for (const { key, label } of KEYS) {
    const k = `set:${t.id}:${m.id}:${key}`;
    // The lead runs in the user's own session, so it has no opposite provider (lib/teams.js setMember refuses it); a
    // seat's model picker offers only what its provider runs.
    const options = !p ? [] : key === "model" ? modelChoices(p, m.provider) : p[key].filter((v) => !(lead && key === "provider" && v === "opposite"));
    const ignored = p && key === "model" ? ignoredModel(p, m.provider, m.model) : null;
    picker(picks, key, label, options, m[key], !p || ctx.busy(k), (v) => void ctx.act(k, setArgs(t.id, m.id, key, v)), ignored);
    if (ignored) picks.createDiv({ cls: "aos-at-note", text: `${m.model}: ${ignored}` });
  }
  switchChip(row, ctx, `pause:${t.id}:${m.id}`, m.paused ? "paused" : "on", !m.paused, (on) => pauseArgs(t.id, !on, m.id),
    `Paused, ${m.name} is never dispatched`);
  const acts = row.createDiv({ cls: "aos-at-rowacts" });
  if (!lead) {
    const rk = `remove:${t.id}:${m.id}`;
    const rm = acts.createEl("button", { cls: "aos-ws-action aos-at-btn aos-at-danger", text: ctx.busy(rk) ? "Removing…" : "Remove", attr: { "aria-label": `Remove ${m.name} from ${t.name}` } });
    rm.disabled = ctx.busy(rk);
    rm.addEventListener("click", () => void ctx.act(rk, removeMemberArgs(t.id, m.id), {
      title: `Remove ${m.name} from ${t.name}?`,
      message: `${m.name}'s block leaves persona/teams/${t.id}/TEAM.md. Its agent, ${m.agent ?? "none"}, stays in your agents. A member who still owns an open item cannot be removed.`,
      cta: "Remove",
    }));
  }
  for (const key of [...KEYS.map((x) => `set:${t.id}:${m.id}:${x.key}`), `pause:${t.id}:${m.id}`, `remove:${t.id}:${m.id}`]) {
    const e = ctx.error(key);
    if (e) { errorLine(table, `${m.name}: ${e}`); break; }
  }
}

/** A labelled select of presets; a value outside them stays visible, marked "(ignored)" when its provider does not run
 *  it and "(custom)" otherwise, and is left as is until another is picked. */
function picker(parent: HTMLElement, key: SetKey, label: string, options: string[], current: string | null, disabled: boolean, onPick: (v: string) => void, ignored: string | null = null): void {
  const wrap = parent.createEl("label", { cls: `aos-at-pick aos-at-pick-${key}`, attr: ignored ? { title: ignored } : {} });
  wrap.createSpan({ cls: "aos-at-label", text: label });
  const sel = wrap.createEl("select", { cls: "dropdown" });
  const cur = current ?? "inherit";
  const list = options.includes(cur) ? options : [cur, ...options];
  for (const v of list) sel.createEl("option", { value: v, text: options.includes(v) ? v : `${v} (${ignored ? "ignored" : "custom"})` });
  sel.value = cur;
  sel.disabled = disabled || !options.length;
  sel.addEventListener("change", () => { if (sel.value !== cur && options.includes(sel.value)) onPick(sel.value); });
}

/** The Settings tab's switch chip: checked is on; a change runs `args(on)`. */
function switchChip(parent: HTMLElement, ctx: TeamsCtx, key: string, label: string, on: boolean, args: (on: boolean) => string[], offTitle: string): void {
  const busy = ctx.busy(key);
  const chip = parent.createEl("label", { cls: `aos-st-switch aos-at-switch${on ? " is-on" : ""}${busy ? " is-busy" : ""}`, attr: { title: on ? "Uncheck to pause" : offTitle } });
  const box = chip.createEl("input", { attr: { type: "checkbox" } });
  box.checked = on;
  box.disabled = busy;
  box.addEventListener("change", () => void ctx.act(key, args(box.checked)));
  chip.createSpan({ cls: "aos-st-switchlabel", text: label });
}

function addMember(host: HTMLElement, ctx: TeamsCtx): void {
  const t = ctx.team;
  const key = `add:${t.id}`;
  const busy = ctx.busy(key);
  const taken = new Set(t.members.map((m) => m.agent).filter(Boolean));
  const mine = groupAgents(ctx.agents.agents).yours.filter((a) => !taken.has(a.id));
  const free = mine.filter(addable).sort((a, b) => a.name.localeCompare(b.name));
  const left = mine.length - free.length;
  const row = host.createDiv({ cls: "aos-at-add" });
  row.createSpan({ cls: "aos-at-label", text: "Add a member" });
  // Such an agent could join by its file name, but a Claude seat runs `claude --agent <that name>`, which Claude Code
  // resolves by the agent's declared name, so the seat would not start: renaming the file is the fix.
  const leftOut = () => { if (left) host.createDiv({ cls: "aos-dim aos-at-hint", text: `${left} of your agents ${left === 1 ? "is" : "are"} left out: ${left === 1 ? "its file is" : "their files are"} named differently from the agent's name, and a seat runs an agent by both. Rename the file to <name>.md (or .toml) to add it.` }); };
  if (!free.length) {
    row.createSpan({ cls: "aos-dim", text: !ctx.agents.agents.length ? "no agents listed yet: create one, then sync in the Agents tab" : mine.length ? "none of your agents can be added here" : "every one of your agents is on this team" });
    leftOut();
    errorLine(host, ctx.error(key));
    return;
  }
  const sel = row.createEl("select", { cls: "dropdown", attr: { "aria-label": "Agent to add" } });
  sel.createEl("option", { value: "", text: "pick one of your agents" });
  for (const a of free) sel.createEl("option", { value: a.id, text: a.description ? `${a.name}: ${a.description.slice(0, 60)}` : a.name });
  // The pick survives a redraw (a file event, the tab's clock, the runtime's sweep) until it is added.
  const picked = ctx.ui.addPick.get(t.id);
  if (picked && free.some((a) => a.id === picked)) sel.value = picked;
  sel.disabled = busy;
  const add = row.createEl("button", { cls: "aos-ws-action aos-at-btn", text: busy ? "Adding…" : "Add" });
  add.disabled = busy || !sel.value;
  sel.addEventListener("change", () => {
    if (sel.value) ctx.ui.addPick.set(t.id, sel.value); else ctx.ui.addPick.delete(t.id);
    add.disabled = busy || !sel.value;
  });
  add.addEventListener("click", () => {
    if (sel.value) void ctx.act(key, addMemberArgs(t.id, sel.value)).then((ok) => { if (ok) ctx.ui.addPick.delete(t.id); });
  });
  row.createSpan({ cls: "aos-dim aos-at-hint", text: "joins as a Member on every stage, on the host that has the agent; set its seat above" });
  leftOut();
  errorLine(host, ctx.error(key));
}

/** Whether `aos team member add` can find this agent: it looks for <agents>/<name>.md or .toml by the name it is given,
 *  so an agent whose file is named differently from the agent is refused (lib/teams.js agentFiles). */
export function addable(a: AgentRow): boolean {
  const base = (p: string | undefined) => (p ? (p.split("/").pop() ?? "").replace(/\.(md|toml)$/, "") : null);
  return [a.on.claude?.path, a.on.codex?.path].some((p) => base(p) === a.id);
}
