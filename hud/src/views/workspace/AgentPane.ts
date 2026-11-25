// AgentPane.ts — an agent's profile in the Agent Workspace (spec 2026-11-12-agent-workspace-design D11, D12). The header
// (name, host pills, description, ❯_ per enabled host, ⧉ copy, open file); NOW, a live run of any of its seats; one SEAT
// block per team it sits in (team, role, stages, provider / model / effort pickers, pause seat, Remove from <team>) and
// Seat in…, the readable teams it is not on; HOSTS (each host's file, original or translated copy, how to reach it,
// read-only, the share chip and share / unshare); RECENT RUNS (its seats' runs across teams, this week's spend, a link
// to Runs). A plugin or config.toml agent is the header and HOSTS only, plus NOW and its SEAT blocks when a hand-edited
// `agent:` seats it (R30). A member whose agent is missing is its SEAT block with a note, which never calls the agent
// missing before the agents list was ever scanned. Every control is a picker or a button, never a text box
// (ui/noTextBoxes.test.ts scans this file). A team write is one `aos team` call through that team's ctx; ❯_ and share /
// unshare go to the tab (`run`, `share`), which owns every spawn.
import { AGENT_HOSTS, addable, isYours, runCommand, sourceLabel, statusChip as shareState } from "../../data/agents";
import type { AgentRow } from "../../data/agents";
import type { SessionHost } from "../../data/aosConfig";
import { Team, MemberStatus, TEAMS_DIR, memberTone, runTone, usd } from "../../data/teams";
import type { Seat, agentRuns } from "../../data/workspace";
import { pauseArgs, removeMemberArgs, addMemberArgs } from "../../data/teamWriter";
import { TeamsCtx, HOST_LABEL, PickClasses, errorLine, since, seatPickers, seatError, statusChip } from "../teams/ui";
import { shell } from "../../host";

/** `aos agents include|exclude` takes an agent in these states; the others are a sync's to settle. */
const CAN_SHARE = new Set(["universal", "pending", "excluded"]);
const RUNS_SHOWN = 10;
const PICK: PickClasses = { pick: "aos-aw-pick", label: "aos-aw-picklabel", note: "aos-aw-picknote" };

export interface AgentPaneOptions {
  agent: AgentRow | null;
  member: { team: Team; id: string } | null;
  seats: Seat[];
  runs: ReturnType<typeof agentRuns>;
  ctxFor: (t: Team) => TeamsCtx;
  hosts: SessionHost[];
  teams: Team[];
  share(r: AgentRow, on: boolean): void;
  run(cmd: string, host: SessionHost): void;
  /** Whether `aos agents sync` copies each host's agents into the other (agents.json sync.on): share / unshare needs it. */
  sharing: boolean;
  /** Shows the Runs tab. */
  openRuns(): void;
}

/** The agent's profile, or (no agent) the member's seat with why it has none. */
export function renderAgent(host: HTMLElement, o: AgentPaneOptions): void {
  const root = host.createDiv({ cls: "aos-aw-agent", attr: { "data-tour": "agent-workspace-agent" } });
  const a = o.agent;
  if (!a) { memberPane(host, root, o); return; }
  host.setAttr("aria-label", a.name);
  header(root, a, o);
  const yours = isYours(a);
  // A plugin or config.toml agent seated by a hand-edited `agent:` keeps its seats' controls (agent-workspace R30), but
  // never Seat in… (addable() refuses it) or the share chip; seated nowhere, it is the header and HOSTS only.
  if (yours || o.seats.length) {
    nowStrip(root, o);
    seatSection(root, o, yours ? a : null);
  }
  hostsSection(root, a, o, yours);
  if (yours) recentRuns(root, o);
}

/** Why ❯_ on `h` is disabled: the agent has no file there, and what (if anything) would change that. Only one of your
 *  own agents waiting to be shared is copied by sync now, and only while sharing is on. */
function noFileWhy(a: AgentRow, h: SessionHost, sharing: boolean): string {
  const why = !isYours(a) ? `it is listed from ${sourceLabel(a)}, not copied`
    : a.status === "pending" && sharing ? "sync now copies it"
      : a.status === "excluded" ? "it is not shared"
        : "";
  return `${a.name} has no ${HOST_LABEL[h]} file${why ? `: ${why}` : ""}`;
}

function section(root: HTMLElement, id: string, label: string): HTMLElement {
  const sec = root.createEl("section", { cls: "aos-aw-sec", attr: { "data-sec": id, "aria-label": label } });
  sec.createDiv({ cls: "aos-aw-sechead", text: label });
  return sec;
}

/** Name, host pills, where it comes from, ❯_ per enabled host (disabled, saying why, where the agent has no file), ⧉
 *  copy how to reach it, open its file; then its description. */
function header(root: HTMLElement, a: AgentRow, o: AgentPaneOptions): void {
  const head = root.createDiv({ cls: "aos-aw-agenthead" });
  head.createEl("h2", { cls: "aos-aw-panetitle", text: a.name });
  const pills = head.createSpan({ cls: "aos-aw-hostpills" });
  for (const h of AGENT_HOSTS) {
    const side = a.on[h];
    pills.createSpan({
      cls: `aos-aw-hostpill ${side ? "is-on" : "is-absent"}`, text: h,
      attr: { "data-host": h, title: side ? `${HOST_LABEL[h]}: ${side.invoke}${side.via === "mirror" ? " (a translated copy)" : ""}` : `not in ${HOST_LABEL[h]}` },
    });
  }
  head.createSpan({ cls: "aos-aw-source", text: sourceLabel(a), attr: { title: a.origin.path } });
  const acts = head.createDiv({ cls: "aos-aw-agentacts" });
  for (const h of o.hosts) {
    const cmd = runCommand(a, h);
    const title = !cmd ? noFileWhy(a, h, o.sharing) : h === "claude" ? `Start a Claude Code session as ${a.name}: ${cmd}` : `Start a Codex session that spawns ${a.name} for the task it asks for: ${cmd}`;
    const b = acts.createEl("button", { cls: "aos-aw-btn aos-aw-run", text: `❯_ ${h}`, attr: { type: "button", "data-host": h, title } });
    b.disabled = !cmd;
    if (cmd) b.addEventListener("click", () => o.run(cmd, h));
  }
  const reach = o.hosts.map((h) => a.on[h]).find(Boolean) ?? a.on.claude ?? a.on.codex;
  if (reach) {
    const cp = acts.createEl("button", { cls: "aos-aw-btn aos-aw-copy", text: "⧉", attr: { type: "button", title: `copy ${reach.invoke}`, "aria-label": "Copy how to reach the agent" } });
    cp.addEventListener("click", () => {
      const clip = typeof navigator === "undefined" ? undefined : navigator.clipboard;
      void (clip ? clip.writeText(reach.invoke) : Promise.reject(new Error("no clipboard"))).then(() => cp.setText("copied"), () => cp.setText("copy failed"));
    });
  }
  const file = a.origin.path;
  if (file) {
    const op = acts.createEl("button", { cls: "aos-aw-btn aos-aw-open", text: "open", attr: { type: "button", title: `Open ${file}` } });
    const failed = (why: string) => { op.setText("cannot open"); op.setAttr("title", `Cannot open ${file}: ${why}`); };
    op.addEventListener("click", () => {
      void Promise.resolve().then(() => shell.openPath(file)).then((err) => { if (err) failed(err); }, (e: unknown) => failed(e instanceof Error ? e.message : String(e)));
    });
  }
  if (a.description) root.createDiv({ cls: "aos-aw-agentdesc", text: a.description });
}

/** NOW: each live run of its seats, by team, with its item, provider and age. */
function nowStrip(root: HTMLElement, o: AgentPaneOptions): void {
  const strip = root.createDiv({ cls: "aos-aw-now", attr: { role: "group", "aria-label": "Now" } });
  strip.createSpan({ cls: "aos-aw-nowlabel", text: "NOW" });
  const live = o.seats.flatMap((s) => s.team.live.filter((x) => x.member === s.member.id).map((run) => ({ team: s.team, run })));
  if (!live.length) { strip.createSpan({ cls: "aos-aw-nowrest", text: "not running" }); return; }
  for (const { team, run } of live) {
    const tName = team.name || team.id;
    const chip = strip.createSpan({
      cls: "aos-aw-who is-working",
      attr: { title: `running ${run.item ?? "a run"} in ${tName}${run.provider ? ` on ${run.provider}` : ""}${run.startedAt ? `, started ${run.startedAt}` : ""}` },
    });
    chip.createSpan({ cls: "aos-aw-dot is-live", attr: { "aria-hidden": "true" } });
    chip.createSpan({ cls: "aos-aw-whoname", text: tName });
    const what = [run.item ?? "", run.provider ?? "", run.startedAt ? since(run.startedAt, o.ctxFor(team).now) : ""].filter(Boolean).join(" · ");
    if (what) chip.createSpan({ cls: "aos-aw-whoitem", text: what });
  }
}

/** SEAT: a block per seat, then Seat in… (none for a member whose agent is missing). */
function seatSection(root: HTMLElement, o: AgentPaneOptions, a: AgentRow | null): void {
  const sec = section(root, "seat", "SEAT");
  if (!o.seats.length) sec.createDiv({ cls: "aos-aw-empty aos-aw-dim", text: "seated in no team: it is on the bench" });
  for (const s of o.seats) seatBlock(sec, o.ctxFor(s.team), s);
  if (o.seats.some((s) => !o.ctxFor(s.team).presets)) {
    sec.createDiv({ cls: "aos-aw-seathint aos-aw-dim", text: "Waiting for aos team list to name the seat presets: until it does, each picker shows its value only." });
  }
  if (a) seatIn(sec, o, a);
}

/** What the seat is doing, as memberStatus has it: the item it runs, is blocked on, or holds. */
function seatState(t: Team, m: MemberStatus): string {
  switch (m.status) {
    case "working": return `working on ${m.item ?? "a run"}`;
    case "blocked": {
      const on = t.board.find((it) => it.status === "blocked" && it.owners.includes(m.id))?.id ?? m.item;
      return `blocked${on ? ` on ${on}` : ""}`;
    }
    case "paused": return m.paused ? "paused" : "paused with its team";
    default: return m.item ? `idle · ${m.item}` : "idle";
  }
}

function seatBlock(parent: HTMLElement, ctx: TeamsCtx, s: Seat): void {
  const t = s.team;
  const m = s.member;
  const tName = t.name || t.id;
  const name = m.name || m.id;
  const box = parent.createDiv({ cls: `aos-aw-seat${m.paused ? " is-paused" : ""}`, attr: { "data-team": t.id, role: "group", "aria-label": `${name} in ${tName}` } });
  const head = box.createDiv({ cls: "aos-aw-seathead" });
  const link = head.createEl("a", { cls: "aos-aw-link aos-aw-seatteam", text: tName, href: "#", attr: { title: `Show ${tName}` } });
  link.addEventListener("click", (e) => { e.preventDefault(); ctx.select(t.id); });
  if (m.lead) head.createSpan({ cls: "aos-aw-lead", text: "lead" });
  head.createSpan({ cls: "aos-aw-seatrole", text: m.role || "Member" });
  head.createSpan({ cls: `aos-aw-seatstate ${memberTone(m.status)}`, text: seatState(t, m) });
  box.createDiv({ cls: "aos-aw-seatline", text: `${m.id} · ${m.stage.includes("all") ? "every stage" : `stages ${m.stage.join(", ")}`}` });
  seatPickers(box.createDiv({ cls: "aos-aw-picks" }), ctx, m, PICK);

  const acts = box.createDiv({ cls: "aos-aw-seatacts" });
  const pk = `pause:${t.id}:${m.id}`;
  const pausing = ctx.busy(pk);
  const pause = acts.createEl("button", {
    cls: "aos-aw-btn aos-aw-pauseseat", text: pausing ? (m.paused ? "Resuming…" : "Pausing…") : m.paused ? "Resume seat" : "Pause seat",
    attr: { type: "button", "data-focus": pk, title: m.paused ? `aos team resume ${t.id} ${m.id}: ${name} can be dispatched again` : `aos team pause ${t.id} ${m.id}: ${name} is never dispatched until it resumes` },
  });
  pause.disabled = pausing;
  pause.addEventListener("click", () => void ctx.act(pk, pauseArgs(t.id, !m.paused, m.id)));
  // Offered to every seat, the lead's too: the runtime refuses the lead and a member who owns an open item, and its
  // reason shows below.
  const rk = `remove:${t.id}:${m.id}`;
  const removing = ctx.busy(rk);
  const rm = acts.createEl("button", { cls: "aos-aw-btn aos-aw-danger aos-aw-remove", text: removing ? "Removing…" : `Remove from ${tName}`, attr: { type: "button", "data-focus": rk } });
  rm.disabled = removing;
  rm.addEventListener("click", () => void ctx.act(rk, removeMemberArgs(t.id, m.id), {
    title: `Remove ${name} from ${tName}?`,
    message: `${name}'s block leaves ${TEAMS_DIR}/${t.id}/TEAM.md.${m.agent ? ` Its agent, ${m.agent}, stays in your agents.` : ""} The lead, and a member who still owns an open item, cannot be removed.`,
    cta: "Remove",
  }));
  errorLine(box, seatError(ctx, m));
}

/** Seat in…: a picker of the readable teams the agent is not on and Seat (`member add`), for an agent `member add` can
 *  find (addable). The pick survives a redraw (the tab's clock, a sweep) until it is seated. */
function seatIn(parent: HTMLElement, o: AgentPaneOptions, a: AgentRow): void {
  const row = parent.createDiv({ cls: "aos-aw-seatin" });
  row.createSpan({ cls: "aos-aw-setlabel", text: "Seat in…" });
  if (!addable(a)) {
    row.createSpan({ cls: "aos-aw-dim", text: `its file is named differently from ${a.name}, and a seat runs an agent by both: rename the file to ${a.id}.md (or .toml) to seat it` });
    return;
  }
  const open = o.teams.filter((t) => !t.error && !t.members.some((m) => m.agent === a.id)).sort((x, y) => (x.name || x.id).localeCompare(y.name || y.id));
  if (!open.length) { row.createSpan({ cls: "aos-aw-dim", text: o.teams.length ? "it sits in every team" : "no teams yet" }); return; }
  const key = `seatin:${a.id}`;
  const ctx = o.ctxFor(open[0]);
  const busy = ctx.busy(key);
  const picks = ctx.ui.seatPick;
  const sel = row.createEl("select", { cls: "dropdown", attr: { "aria-label": `Team to seat ${a.name} in`, "data-focus": `${key}:pick` } });
  sel.createEl("option", { value: "", text: "pick a team" });
  for (const t of open) sel.createEl("option", { value: t.id, text: t.name || t.id });
  const picked = picks?.get(a.id);
  if (picked && open.some((t) => t.id === picked)) sel.value = picked;
  sel.disabled = busy;
  const go = row.createEl("button", { cls: "aos-aw-btn aos-aw-seatgo", text: busy ? "Seating…" : "Seat", attr: { type: "button", "data-focus": key } });
  go.disabled = busy || !sel.value;
  sel.addEventListener("change", () => {
    if (sel.value) picks?.set(a.id, sel.value); else picks?.delete(a.id);
    go.disabled = busy || !sel.value;
  });
  go.addEventListener("click", () => {
    const t = open.find((x) => x.id === sel.value);
    if (t) void o.ctxFor(t).act(key, addMemberArgs(t.id, a.id)).then((ok) => { if (ok) picks?.delete(a.id); });
  });
  row.createSpan({ cls: "aos-aw-dim aos-aw-addhint", text: "joins as a Member on every stage, on the host that has the agent" });
  errorLine(parent, ctx.error(key));
}

/** HOSTS: each host's side (its file, original or translated copy, how to reach it), then read-only and, for your own
 *  agents, the share chip and share / unshare while sharing is on; a plugin's agent is listed, never copied. */
function hostsSection(root: HTMLElement, a: AgentRow, o: AgentPaneOptions, yours: boolean): void {
  const sec = section(root, "hosts", "HOSTS");
  for (const h of AGENT_HOSTS) {
    const side = a.on[h];
    if (!side && !o.hosts.includes(h)) continue;
    const row = sec.createDiv({ cls: `aos-aw-hostrow${side ? "" : " is-absent"}`, attr: { "data-host": h } });
    row.createSpan({ cls: "aos-aw-hostname", text: HOST_LABEL[h] });
    if (!side) { row.createSpan({ cls: "aos-aw-hostvia", text: `not in ${HOST_LABEL[h]}` }); continue; }
    row.createSpan({ cls: "aos-aw-hostvia", text: side.via === "mirror" ? "translated copy" : "original" });
    row.createEl("code", { cls: "aos-aw-hostinvoke", text: side.invoke, attr: { title: `How to reach it in ${HOST_LABEL[h]}` } });
    if (side.path) row.createSpan({ cls: "aos-aw-hostfile", text: side.path, attr: { title: side.path } });
  }
  const foot = sec.createDiv({ cls: "aos-aw-hostfoot" });
  if (a.readOnly) foot.createSpan({ cls: "aos-aw-ro", text: "read-only", attr: { title: "its tools cannot write: read-only on both hosts" } });
  if (!yours) { foot.createSpan({ cls: "aos-aw-dim", text: `listed from ${sourceLabel(a)}, not copied` }); return; }
  const chip = shareState(a);
  statusChip(foot, chip.cls, chip.text, a.note ?? undefined).addClass("aos-aw-sharechip");
  if (o.sharing && CAN_SHARE.has(a.status)) {
    const on = a.status === "excluded";
    const b = foot.createEl("button", {
      cls: "aos-aw-btn aos-aw-share", text: on ? "share" : "unshare",
      attr: { type: "button", title: on ? "aos agents include: copy it into the other host again" : "aos agents exclude: stop copying it into the other host (its copy there is removed)" },
    });
    b.addEventListener("click", () => o.share(a, on));
  }
}

/** RECENT RUNS: its seats' runs, newest first, with this week's spend and a link to Runs. */
function recentRuns(root: HTMLElement, o: AgentPaneOptions): void {
  const sec = section(root, "runs", "RECENT RUNS");
  const line = sec.createDiv({ cls: "aos-aw-runsline" });
  line.createSpan({ cls: "aos-aw-weekusd", text: `${usd(o.runs.weekUsd)} this week` });
  const go = line.createEl("a", { cls: "aos-aw-link aos-aw-runslink", text: "Runs →", href: "#", attr: { title: "Open the Runs tab" } });
  go.addEventListener("click", (e) => { e.preventDefault(); o.openRuns(); });
  const runs = o.runs.runs;
  if (!runs.length || !o.seats.length) { sec.createDiv({ cls: "aos-aw-empty aos-aw-dim", text: o.seats.length ? "no runs yet" : "no runs: it sits in no team" }); return; }
  const now = o.ctxFor(o.seats[0].team).now;
  for (const r of runs.slice(0, RUNS_SHOWN)) {
    const row = sec.createDiv({ cls: "aos-aw-runrow" });
    row.createSpan({ cls: "aos-aw-evtime", text: since(r.ts, now), attr: { title: r.ts } });
    row.createSpan({ cls: `aos-aw-dot ${runTone(r.status)}`, attr: { "aria-hidden": "true" } });
    const team = o.teams.find((t) => t.id === r.team);
    const bits = [team?.name || r.team, r.item ?? "a run", r.status === "?" ? "" : r.status, r.provider ?? "", r.usd != null ? usd(r.usd) : ""];
    row.createSpan({ cls: "aos-aw-runtext", text: bits.filter(Boolean).join(" · ") });
  }
  if (runs.length > RUNS_SHOWN) sec.createDiv({ cls: "aos-aw-dim aos-aw-runsmore", text: `and ${runs.length - RUNS_SHOWN} older` });
}

/** A member whose agent is missing (D12): its name, why it has none, and its SEAT block. Before the agents list was ever
 *  scanned nothing can be called missing, so the note says the list is not built yet. */
function memberPane(host: HTMLElement, root: HTMLElement, o: AgentPaneOptions): void {
  const mm = o.member;
  if (!mm) return;
  const m = o.seats[0]?.member ?? mm.team.members.find((x) => x.id === mm.id);
  const name = m?.name || mm.id;
  host.setAttr("aria-label", name);
  root.createDiv({ cls: "aos-aw-agenthead" }).createEl("h2", { cls: "aos-aw-panetitle", text: name });
  const scanned = o.ctxFor(mm.team).agents.scannedAt !== null;
  const agent = m?.agent ?? null;
  root.createDiv({
    cls: "aos-aw-noagentnote",
    text: !scanned
      ? `the agents list is not scanned yet — sync now builds it${agent ? `; this seat runs ${agent}` : ""}`
      : agent ? `no agent: ${agent} is not one of your agents, so this seat cannot run` : "no agent: its seat names none",
  });
  seatSection(root, o, null);
}
