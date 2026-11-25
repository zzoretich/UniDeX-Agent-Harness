import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import * as path from "path";
import { parseAgents } from "../data/agents";
import { readTeams, diskAdapter } from "../data/teams";
import type { Team } from "../data/teams";
import type * as NewTeam from "./NewTeamModal";

// + New team (spec 2026-11-12-agent-workspace-design D14): what Create would make of the fields, and the dialog itself
// drawn into a small fake of Obsidian's Modal and DOM helpers. The write is the caller's (`onCreate`, the tab's act): the
// dialog builds its argv, waits for the verdict, and shows a refusal in place.
type Opts = { cls?: string; text?: string; attr?: Record<string, string>; value?: string };
type Ev = { key?: string; isComposing?: boolean };
const doc: { activeElement: El | null } = { activeElement: null };
class El {
  kids: El[] = [];
  cls = new Set<string>();
  attrs = new Map<string, string>();
  own: string;
  value: string;
  disabled = false;
  parent: El | null = null;
  private on = new Map<string, ((e: unknown) => void)[]>();
  constructor(public tag: string, o: Opts = {}) {
    for (const c of (o.cls ?? "").split(/\s+/).filter(Boolean)) this.cls.add(c);
    for (const [k, v] of Object.entries(o.attr ?? {})) this.attrs.set(k, v);
    this.own = o.text ?? "";
    this.value = o.value ?? "";
  }
  createEl(tag: string, o?: Opts): El { const e = new El(tag, o); e.parent = this; this.kids.push(e); return e; }
  createDiv(o?: Opts): El { return this.createEl("div", o); }
  createSpan(o?: Opts): El { return this.createEl("span", o); }
  setAttr(k: string, v: string): void { this.attrs.set(k, v); }
  getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
  removeAttribute(k: string): void { this.attrs.delete(k); }
  addClass(c: string): void { this.cls.add(c); }
  toggleClass(c: string, on: boolean): void { if (on) this.cls.add(c); else this.cls.delete(c); }
  empty(): void { this.kids = []; }
  setText(s: string): void { this.own = s; this.kids = []; }
  remove(): void { if (this.parent) this.parent.kids = this.parent.kids.filter((k) => k !== this); this.parent = null; }
  focus(): void { doc.activeElement = this; }
  addEventListener(ev: string, fn: (e: unknown) => void): void { this.on.set(ev, [...(this.on.get(ev) ?? []), fn]); }
  fire(ev: string, e: Ev = {}): void { for (const fn of this.on.get(ev) ?? []) fn({ preventDefault() {}, stopPropagation() {}, target: this, ...e }); }
  get text(): string { return this.own + this.kids.map((k) => k.text).join(""); }
  all(): El[] { return [this, ...this.kids.flatMap((k) => k.all())]; }
  one(cls: string): El { const e = this.all().find((x) => x.cls.has(cls)); assert.ok(e, `no .${cls}`); return e; }
  get options(): El[] { return this.kids.filter((k) => k.tag === "option"); }
}

const body = new El("body");
class FakeModal {
  modalEl: El;
  contentEl: El;
  closed = 0;
  constructor(public app: unknown) {
    this.modalEl = body.createDiv({ cls: "modal" });
    this.contentEl = this.modalEl.createDiv({ cls: "modal-content" });
  }
  open(): void { void (this as unknown as { onOpen(): void }).onOpen(); }
  close(): void { this.closed++; void (this as unknown as { onClose(): void }).onClose(); this.modalEl.remove(); }
}

const STUB = "obsidian-stub-newteam";
const M = Module as unknown as { _resolveFilename(request: string, ...rest: unknown[]): string };
const resolve = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "obsidian" ? STUB : resolve.call(this, request, ...rest);
};
class Stub {}
require.cache[STUB] = { id: STUB, filename: STUB, loaded: true, exports: { Modal: FakeModal, FuzzySuggestModal: Stub, App: Stub } } as unknown as NodeJS.Module;

const { NewTeamModal, newTeamCheck, leadsFrom } = require("./NewTeamModal") as typeof NewTeam;

const VAULT = path.resolve(__dirname, "../data/fixtures/teams-vault");
const agent = (id: string, o: { scope?: string; claude?: string | null; codex?: string | null; description?: string } = {}) => ({
  id, name: id, description: o.description ?? "", origin: { host: o.claude === null ? "codex" : "claude", scope: o.scope ?? "user", path: "" },
  on: {
    claude: o.claude === null ? null : { invoke: `@agent-${id}`, path: `/c/agents/${o.claude ?? id}.md`, run: `claude --agent ${id}` },
    codex: o.codex ? { invoke: id, path: `/x/agents/${o.codex}.toml`, run: `codex 'Use the ${id} agent.'` } : null,
  },
});
const AGENTS = parseAgents(JSON.stringify({ schema: 1, scannedAt: "2026-11-20T00:00:00.000Z", agents: [
  agent("team-lead", { description: "Runs the board" }),
  agent("builder", { codex: "builder" }),
  agent("ops-bot", { claude: null, codex: "ops-bot" }),
  agent("my-reviewer", { claude: "reviewer" }),      // its file is reviewer.md: aos team cannot find it by its name
  agent("kit:planner", { scope: "plugin" }),
] })).agents;
const ids = (rows: { id: string }[]) => rows.map((a) => a.id);
async function teams(): Promise<Team[]> { return readTeams(diskAdapter(VAULT)); }

const flush = async (): Promise<void> => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); };

test("leadsFrom: your agents whose file on a host that is on carries their name, by name; a plugin's never", () => {
  assert.deepEqual(ids(leadsFrom(AGENTS, ["claude", "codex"])), ["builder", "ops-bot", "team-lead"]);
  assert.deepEqual(ids(leadsFrom(AGENTS, ["claude"])), ["builder", "team-lead"], "Claude-only: no Codex-only agent");
  assert.deepEqual(ids(leadsFrom(AGENTS, ["codex"])), ["builder", "ops-bot"], "Codex-only: only agents with a Codex file");
  assert.deepEqual(leadsFrom(AGENTS, []), []);
});

test("newTeamCheck: the id follows the name; why Create is off: no name, a bad name, an emoji-only name, a taken id, no lead", async () => {
  const ts = await teams();
  const leads = leadsFrom(AGENTS, ["claude"]);
  const check = (name: string, lead = "team-lead", l = leads) => newTeamCheck({ name, lead }, ts, l, ["claude"]);
  assert.deepEqual(check("  Harbor Crew  "), { id: "harbor-crew", reason: null });
  assert.deepEqual(check("Café Ops 2"), { id: "cafe-ops-2", reason: null });
  assert.equal(check("").reason, "Name the team: its id is made from the name.");
  assert.equal(check("   ").id, null);
  assert.equal(check("🚢🌊").id, null);
  assert.equal(check("🚢🌊").reason, "No team id can be made from this name: put a letter (a–z) in it.");
  assert.equal(check("-crew").reason, "A name cannot start with -.");
  assert.equal(check("tab\there").reason, "A name is one line, with no control character.");
  assert.equal(check("x".repeat(61)).reason, "A name is at most 60 characters.");
  // The fixture vault has a lab team (and a broken one, whose folder is as taken).
  assert.deepEqual(check("Lab"), { id: "lab", reason: "A team with the id lab already exists." });
  assert.equal(check("Broken").reason, "A team with the id broken already exists.");
  assert.deepEqual(check("Harbor Crew", ""), { id: "harbor-crew", reason: "Pick the agent that leads it." });
  assert.equal(check("Harbor Crew", "kit:planner").reason, "Pick the agent that leads it.", "only a listed lead counts");
  assert.equal(check("Harbor Crew", "", []).reason, "None of your agents can lead a team on Claude Code: a lead needs its own file, <name>.md, in Claude Code's agents folder.");
  assert.equal(newTeamCheck({ name: "Harbor Crew", lead: "" }, ts, [], ["codex"]).reason, "None of your agents can lead a team on Codex: a lead needs its own file, <name>.toml, in Codex's agents folder.");
  assert.equal(newTeamCheck({ name: "Harbor Crew", lead: "" }, ts, [], ["claude", "codex"]).reason, "None of your agents can lead a team: a lead needs its own file, <name>.md or <name>.toml, in Claude Code's or Codex's agents folder.");
  assert.equal(newTeamCheck({ name: "Harbor Crew", lead: "" }, ts, [], []).reason, "No host is on: turn Claude Code or Codex on in Settings, then pick a lead.");
});

/** Opens the dialog over the fixture's teams; `verdicts` answers each Create in turn. */
async function open(verdicts: boolean[], o: { failure?: string | null; hosts?: ("claude" | "codex")[] } = {}) {
  body.kids = [];
  doc.activeElement = null;
  const calls: string[][] = [];
  const ts = await teams();
  let release: (() => void) | null = null;
  const m = new NewTeamModal({} as never, {
    agents: AGENTS, teams: ts, hosts: o.hosts ?? ["claude"],
    onCreate: async (args) => {
      calls.push(args);
      await new Promise<void>((r) => { release = r; });
      return verdicts.shift() ?? false;
    },
    failure: () => o.failure ?? null,
  });
  m.open();
  const modal = body.kids[0];
  const name = modal.all().find((e) => e.tag === "input")!;
  const [lead, parent] = modal.all().filter((e) => e.tag === "select");
  const create = modal.all().find((e) => e.tag === "button" && e.text.startsWith("Creat"))!;
  const type = (v: string) => { name.value = v; name.fire("input"); };
  const pick = (sel: El, v: string) => { sel.value = v; sel.fire("change"); };
  const answer = async () => { await flush(); release?.(); await flush(); };
  return { m: m as unknown as FakeModal, modal, name, lead, parent, create, type, pick, calls, answer };
}

test("the dialog: a named dialog whose name field has the keyboard; the id follows the name; Create is off with the reason; Enter submits only when it is on", async () => {
  const d = await open([true]);
  assert.equal(d.modal.getAttribute("role"), "dialog");
  assert.equal(d.modal.getAttribute("aria-modal"), "true");
  const title = d.modal.all().find((e) => e.tag === "h3")!;
  assert.equal(title.text, "New team");
  assert.equal(d.modal.getAttribute("aria-labelledby"), title.getAttribute("id"));
  assert.equal(doc.activeElement, d.name, "the name field has the keyboard");
  assert.equal(d.name.getAttribute("type"), "text");
  assert.equal(d.name.getAttribute("maxlength"), "60");
  // Pickers, not text boxes: the lead from your addable agents on the hosts that are on, the parent from the teams.
  assert.deepEqual(d.lead.options.map((x) => x.value), ["", "builder", "team-lead"]);
  assert.equal(d.lead.options[2].text, "team-lead: Runs the board");
  assert.deepEqual(d.parent.options.map((x) => x.value), ["", "lab", "ops"], "a broken team cannot be a parent");
  assert.equal(d.parent.options[0].text, "none: a top-level team");
  assert.equal(d.create.disabled, true);
  assert.equal(d.modal.one("aos-aw-newwhy").text, "Name the team: its id is made from the name.");

  d.type("Harbor Crew");
  assert.equal(d.modal.one("aos-aw-newid").text, "id harbor-crew · persona/teams/harbor-crew/");
  assert.equal(d.modal.one("aos-aw-newwhy").text, "Pick the agent that leads it.");
  d.name.fire("keydown", { key: "Enter" });
  assert.deepEqual(d.calls, [], "Enter does nothing while Create is off");
  d.type("🚢🌊");
  assert.equal(d.modal.one("aos-aw-newid").text, "id —");
  assert.equal(d.modal.one("aos-aw-newwhy").text, "No team id can be made from this name: put a letter (a–z) in it.");
  assert.equal(d.name.getAttribute("aria-invalid"), "true");
  d.type("Lab");
  assert.equal(d.modal.one("aos-aw-newwhy").text, "A team with the id lab already exists.");
  assert.equal(d.create.disabled, true);

  d.type("Harbor Crew");
  d.pick(d.lead, "team-lead");
  assert.equal(d.create.disabled, false);
  assert.equal(d.modal.one("aos-aw-newwhy").text, "");
  assert.equal(d.name.getAttribute("aria-invalid"), null);
  d.name.fire("keydown", { key: "Enter", isComposing: true });
  assert.deepEqual(d.calls, [], "an IME's Enter is not a submit");
  d.name.fire("keydown", { key: "Enter" });
  assert.deepEqual(d.calls, [["new", "harbor-crew", "--name", "Harbor Crew", "--lead", "team-lead"]]);
  await d.answer();
  assert.equal(d.m.closed, 1, "a team made closes the dialog");
});

test("Create sends the trimmed name, the lead and the parent; a refusal keeps the dialog open with aos team's words and Create on again", async () => {
  const d = await open([false, true], { failure: "persona/teams/harbor-crew already exists" });
  d.type("  Harbor Crew ");
  d.pick(d.lead, "builder");
  d.pick(d.parent, "lab");
  d.create.fire("click");
  assert.deepEqual(d.calls, [["new", "harbor-crew", "--name", "Harbor Crew", "--lead", "builder", "--parent", "lab"]]);
  // While it runs: Creating…, every field held, and a second click sends nothing.
  assert.equal(d.create.text, "Creating…");
  assert.ok([d.create, d.name, d.lead, d.parent].every((e) => e.disabled));
  d.create.fire("click");
  d.name.fire("keydown", { key: "Enter" });
  assert.equal(d.calls.length, 1);
  await d.answer();
  assert.equal(d.m.closed, 0, "a refusal keeps the dialog open");
  assert.equal(d.create.text, "Create");
  assert.ok([d.create, d.name, d.lead, d.parent].every((e) => !e.disabled), "Create is on again");
  const err = d.modal.one("aos-aw-newerror");
  assert.equal(err.text, "persona/teams/harbor-crew already exists");
  assert.equal(err.getAttribute("role"), "alert");
  // An edit clears it; the next Create goes through.
  d.pick(d.parent, "");
  assert.equal(d.modal.one("aos-aw-newerror").text, "");
  d.create.fire("click");
  assert.deepEqual(d.calls[1], ["new", "harbor-crew", "--name", "Harbor Crew", "--lead", "builder"]);
  await d.answer();
  assert.equal(d.m.closed, 1);
});

test("a refusal with no words of its own still says nothing was made; Cancel closes without a write", async () => {
  const d = await open([false], { failure: null });
  d.type("Harbor Crew");
  d.pick(d.lead, "team-lead");
  d.create.fire("click");
  await d.answer();
  assert.equal(d.modal.one("aos-aw-newerror").text, "The team was not created.");
  const cancel = d.modal.all().find((e) => e.tag === "button" && e.text === "Cancel")!;
  cancel.fire("click");
  assert.equal(d.m.closed, 1);
  assert.equal(d.calls.length, 1);
});

test("on a Codex-only machine the lead picker lists agents with a Codex file; with none, it says why and Create stays off", async () => {
  const d = await open([], { hosts: ["codex"] });
  assert.deepEqual(d.lead.options.map((x) => x.value), ["", "builder", "ops-bot"]);
  body.kids = [];
  const none = new NewTeamModal({} as never, { agents: AGENTS.filter((a) => !a.on.codex), teams: [], hosts: ["codex"], onCreate: async () => true });
  none.open();
  const modal = body.kids[0];
  modal.all().find((e) => e.tag === "input")!.value = "Harbor Crew";
  modal.all().find((e) => e.tag === "input")!.fire("input");
  const lead = modal.all().filter((e) => e.tag === "select")[0];
  assert.equal(lead.disabled, true);
  assert.deepEqual(lead.options.map((x) => x.text), ["no agent can lead here"]);
  assert.equal(modal.one("aos-aw-newwhy").text, "None of your agents can lead a team on Codex: a lead needs its own file, <name>.toml, in Codex's agents folder.");
  assert.equal(modal.all().find((e) => e.tag === "button" && e.text === "Create")!.disabled, true);
});
