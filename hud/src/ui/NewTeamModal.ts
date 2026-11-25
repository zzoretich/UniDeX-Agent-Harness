import { App, Modal } from "obsidian";
import { addableOn, groupAgents } from "../data/agents";
import type { AgentHost, AgentRow } from "../data/agents";
import type { Team } from "../data/teams";
import { newTeamArgs, teamIdFrom } from "../data/teamWriter";
import { dialogId } from "./spaces/SpaceDialogs";

/**
 * + New team (spec 2026-11-12-agent-workspace-design D14): a team name, the id made from it (teamIdFrom) shown under the
 * field, a lead picked from your agents that `aos team new` can find on a host that is on, and an optional parent team.
 * The name is the one text box (data entry); the rest are pickers. Create builds `aos team new`'s argv and hands it to
 * `onCreate`, the Agent Workspace tab's own runner: the dialog writes and spawns nothing itself. It waits for the verdict,
 * closes on success, and on a refusal stays open with the refusal's words (aos team new's, or the app's when the
 * team-create surface is off) and Create on again.
 */
export interface NewTeamOptions {
  agents: AgentRow[];
  teams: Team[];
  /** Runs the argv; true only when the team was made. */
  onCreate(args: string[]): Promise<boolean>;
  /** The hosts that are on: a lead needs its file on one of them. Both when left out. */
  hosts?: readonly AgentHost[];
  /** Why the last Create was refused, as the tab recorded it. */
  failure?(): string | null;
}

/** aos team new's limit on a name, which the team-create surface's argv rule shares. */
export const NAME_MAX = 60;
const HOST_LABEL: Record<AgentHost, string> = { claude: "Claude Code", codex: "Codex" };
const HOST_EXT: Record<AgentHost, string> = { claude: ".md", codex: ".toml" };

/** The agents that may lead: your own (not a plugin's or a config.toml role) whose file on a host that is on carries the
 *  agent's name, so `aos team new --lead` finds it; by name. */
export function leadsFrom(agents: readonly AgentRow[], hosts: readonly AgentHost[]): AgentRow[] {
  return groupAgents([...agents]).yours.filter((a) => addableOn(a, hosts)).sort((a, b) => a.name.localeCompare(b.name));
}

export interface NewTeamCheck {
  /** The id the name gives, or null when none is left (an emoji-only name). */
  id: string | null;
  /** Why Create is off; null when it is on. */
  reason: string | null;
}

/** What Create would make of the fields: the id, and the first thing that keeps Create off. */
export function newTeamCheck(f: { name: string; lead: string }, teams: readonly Team[], leads: readonly AgentRow[], hosts: readonly AgentHost[]): NewTeamCheck {
  const name = f.name.trim();
  const id = teamIdFrom(name);
  const off = (reason: string): NewTeamCheck => ({ id, reason });
  if (!name) return off("Name the team: its id is made from the name.");
  if (name.length > NAME_MAX) return off(`A name is at most ${NAME_MAX} characters.`);
  if (/[\0-\x1f\x7f-\x9f\u2028\u2029]/.test(name)) return off("A name is one line, with no control character.");
  if (name.startsWith("-")) return off("A name cannot start with -.");
  if (!id) return off("No team id can be made from this name: put a letter (a–z) in it.");
  if (teams.some((t) => t.id === id)) return off(`A team with the id ${id} already exists.`);
  if (!leads.length) return off(noLead(hosts));
  if (!leads.some((a) => a.id === f.lead)) return off("Pick the agent that leads it.");
  return { id, reason: null };
}

function noLead(hosts: readonly AgentHost[]): string {
  if (!hosts.length) return "No host is on: turn Claude Code or Codex on in Settings, then pick a lead.";
  const on = hosts.length === 1 ? ` on ${HOST_LABEL[hosts[0]]}` : "";
  const files = hosts.map((h) => `<name>${HOST_EXT[h]}`).join(" or ");
  const where = hosts.map((h) => `${HOST_LABEL[h]}'s`).join(" or ");
  return `None of your agents can lead a team${on}: a lead needs its own file, ${files}, in ${where} agents folder.`;
}

export class NewTeamModal extends Modal {
  private hosts: readonly AgentHost[];

  constructor(app: App, private o: NewTeamOptions) {
    super(app);
    this.hosts = o.hosts ?? ["claude", "codex"];
  }

  onOpen(): void {
    const { contentEl, modalEl } = this;
    const leads = leadsFrom(this.o.agents, this.hosts);
    const parents = this.o.teams.filter((t) => !t.error).sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
    const ids = { title: dialogId("newteam-title"), id: dialogId("newteam-id"), why: dialogId("newteam-why") };
    modalEl.addClass("mod-aw-newteam");
    modalEl.setAttr("role", "dialog");
    modalEl.setAttr("aria-modal", "true");
    modalEl.setAttr("aria-labelledby", ids.title);
    contentEl.empty();
    contentEl.addClass("aos-aw-newteam");
    contentEl.createEl("h3", { cls: "aos-aw-newtitle", text: "New team", attr: { id: ids.title } });
    contentEl.createEl("p", { cls: "aos-aw-newsub", text: "A team starts with one member, the lead you pick, and the example team's stages, gates and budget. Seat more agents from its Settings." });

    const nameField = contentEl.createEl("label", { cls: "aos-aw-newfield" });
    nameField.createSpan({ cls: "aos-aw-newlabel", text: "Name" });
    const name = nameField.createEl("input", {
      cls: "aos-aw-newname",
      attr: { type: "text", maxlength: String(NAME_MAX), placeholder: "Harbor crew", autocomplete: "off", spellcheck: "false", "aria-describedby": `${ids.id} ${ids.why}` },
    });
    const idLine = contentEl.createDiv({ cls: "aos-aw-newid", attr: { id: ids.id } });

    const leadField = contentEl.createEl("label", { cls: "aos-aw-newfield" });
    leadField.createSpan({ cls: "aos-aw-newlabel", text: "Lead" });
    const lead = leadField.createEl("select", { cls: "dropdown aos-aw-newlead" });
    if (leads.length) {
      lead.createEl("option", { value: "", text: "pick one of your agents" });
      for (const a of leads) lead.createEl("option", { value: a.id, text: a.description ? `${a.name}: ${a.description.slice(0, 60)}` : a.name });
    } else lead.createEl("option", { value: "", text: "no agent can lead here" });

    const parentField = contentEl.createEl("label", { cls: "aos-aw-newfield" });
    parentField.createSpan({ cls: "aos-aw-newlabel", text: "Parent" });
    const parent = parentField.createEl("select", { cls: "dropdown aos-aw-newparent" });
    parent.createEl("option", { value: "", text: "none: a top-level team" });
    for (const t of parents) parent.createEl("option", { value: t.id, text: t.name && t.name !== t.id ? `${t.name} (${t.id})` : t.id });

    const why = contentEl.createDiv({ cls: "aos-aw-newwhy", attr: { id: ids.why, "aria-live": "polite" } });
    const error = contentEl.createDiv({ cls: "aos-aw-newerror", attr: { role: "alert" } });
    const acts = contentEl.createDiv({ cls: "aos-aw-newacts" });
    const cancel = acts.createEl("button", { cls: "aos-aw-btn", text: "Cancel", attr: { type: "button" } });
    const create = acts.createEl("button", { cls: "aos-aw-btn aos-aw-primary", text: "Create", attr: { type: "button" } });

    let busy = false;
    const check = (): NewTeamCheck => newTeamCheck({ name: name.value, lead: lead.value }, this.o.teams, leads, this.hosts);
    const update = (): void => {
      const c = check();
      idLine.setText(c.id ? `id ${c.id} · persona/teams/${c.id}/` : "id —");
      why.setText(c.reason ?? "");
      // The name is at fault once there is one and the reason is the name's (no id, taken, a bad character).
      const nameAtFault = !!name.value.trim() && !!c.reason && !/^(Pick|None|No host)/.test(c.reason);
      if (nameAtFault) name.setAttr("aria-invalid", "true"); else name.removeAttribute("aria-invalid");
      create.setText(busy ? "Creating…" : "Create");
      create.disabled = busy || !!c.reason;
      name.disabled = busy;
      lead.disabled = busy || !leads.length;
      parent.disabled = busy;
    };
    const edited = (): void => { error.setText(""); update(); };
    const submit = async (): Promise<void> => {
      const c = check();
      if (busy || c.reason || !c.id) return;
      busy = true;
      error.setText("");
      update();
      let ok = false;
      try {
        ok = await this.o.onCreate(newTeamArgs(c.id, name.value.trim(), lead.value, parent.value || null));
      } finally {
        busy = false;
      }
      if (ok) { this.close(); return; }
      error.setText(this.o.failure?.() || "The team was not created.");
      update();
    };

    name.addEventListener("input", edited);
    lead.addEventListener("change", edited);
    parent.addEventListener("change", edited);
    // Enter in the name field is Create, only while Create is on (an IME's Enter composes a character).
    name.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.isComposing) return;
      e.preventDefault();
      if (!create.disabled) void submit();
    });
    cancel.addEventListener("click", () => this.close());
    create.addEventListener("click", () => void submit());
    update();
    name.focus();
  }

  onClose(): void { this.contentEl.empty(); }
}
