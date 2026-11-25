// TeamPane.ts — a team node's pane in the Agent Workspace (spec 2026-11-12-agent-workspace-design D6): a header line (lead,
// members, open items, spend this week) with ❯_ talk to the lead per enabled host, the paused banner, a NOW strip of the
// members working or blocked (the idle ones counted), this team's gate cards (renderGateCard, unchanged), then the
// Activity · Items · Channel · Settings views, Activity by default: Items as a list or today's board (D8), the Channel is
// today's Interact pane (D9), Settings the team's facts and its few controls (D10). A team whose files cannot be read
// shows its error.
import { Team, TEAMS_DIR, gateCards, memberStatus, memberTone, usd } from "../../data/teams";
import { weekUsd } from "../../data/workspace";
import { pauseArgs } from "../../data/teamWriter";
import { TeamsCtx, TeamsView, HOST_LABEL, errorLine, since, talkCommand } from "../teams/ui";
import { renderGateCard } from "../teams/BoardPane";
import { renderInteract } from "../teams/InteractPane";
import { renderActivity } from "./ActivityPane";
import { ItemsMode, renderItems } from "./ItemsPane";
import { renderSettings } from "./SettingsPane";

export const TEAM_VIEWS: { id: TeamsView; label: string }[] = [
  { id: "activity", label: "Activity" }, { id: "items", label: "Items" }, { id: "channel", label: "Channel" }, { id: "settings", label: "Settings" },
];

/** The view a team pane shows for any TeamsView: the old tab's names (a gate card's item link asks for "board", an item's
 *  posts for "interact") land on the view that took their place. */
export function teamView(v: TeamsView): TeamsView {
  switch (v) {
    case "board": return "items";
    case "interact": return "channel";
    case "roster": case "manage": return "settings";
    default: return v;
  }
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

/** How Items shows (the HUD's settings.agentWorkspace.items) and how a pick on its toggle is saved. */
export interface ItemsChoice { mode: ItemsMode; onMode: (m: ItemsMode) => void }

export function renderTeamPane(host: HTMLElement, ctx: TeamsCtx, view: TeamsView, onView: (v: TeamsView) => void,
  items: ItemsChoice = { mode: "list", onMode: () => {} }): void {
  const t = ctx.team;
  host.setAttr("aria-label", `${t.name || t.id} team`);
  const head = host.createDiv({ cls: "aos-aw-teamhead" });
  head.createEl("h2", { cls: "aos-aw-panetitle", text: t.name || t.id });
  if (t.error) { brokenCard(host, ctx, t); return; }

  const lead = t.members.find((m) => m.id === t.lead);
  const leadName = lead?.name ?? (t.lead || "none");
  const open = t.board.filter((i) => i.status !== "done").length;
  head.createSpan({ cls: "aos-aw-teamline", text: [`lead ${leadName}`, plural(t.members.length, "member"), `${open} open`, `${usd(weekUsd(t.runs, ctx.now))} this week`].join(" · ") });
  talkButtons(head, ctx, lead?.agent ?? null, leadName);

  if (t.disabled) pausedBanner(host, ctx, t);
  if (t.state.length) {
    const st = host.createDiv({ cls: "aos-aw-state" });
    for (const l of t.state) st.createDiv({ text: l });
  }
  for (const w of t.warnings) errorLine(host, w);
  if (t.skipped) host.createDiv({ cls: "aos-aw-skipped aos-aw-dim", text: `${plural(t.skipped, "line")} in this team's JSONL files could not be read and ${t.skipped === 1 ? "is" : "are"} skipped` });

  nowStrip(host, ctx, t);

  const cards = gateCards([t]);
  if (cards.length) {
    const box = host.createEl("section", { cls: "aos-aw-gates", attr: { "aria-label": `Gates waiting on you in ${t.name}` } });
    box.createDiv({ cls: "aos-aw-gateshead", text: `NEEDS YOU · ${cards.length}` });
    for (const c of cards) renderGateCard(box, ctx, c, { showTeam: false });
  }

  const shown = teamView(view);
  const bar = viewTabs(host, t, open, shown, onView);
  const label = TEAM_VIEWS.find((v) => v.id === shown)?.label ?? shown;
  const panel = host.createDiv({ cls: "aos-aw-viewpane", attr: { role: "tabpanel", "aria-label": label, "data-view": shown } });
  if (shown === "activity") {
    // The page count lives in the tab's state, per team, so a redraw (a file event, the clock) keeps what "older" showed.
    const pages = ctx.ui.activityPages;
    const page = pages?.get(t.id) ?? 1;
    renderActivity(panel, ctx, page, () => { pages?.set(t.id, page + 1); ctx.render(); });
  } else if (shown === "items") {
    renderItems(panel, ctx, items.mode, items.onMode, bar);
  } else if (shown === "channel") {
    renderInteract(panel, ctx);
  } else {
    renderSettings(panel, ctx);
  }
}

/** ❯_ talk to the lead: its agent's own session (talkCommand, as Interact's Talk to), one button per enabled host that
 *  has the agent; with two hosts each button names its host. */
function talkButtons(head: HTMLElement, ctx: TeamsCtx, agent: string | null, leadName: string): void {
  let acts: HTMLElement | null = null;
  for (const h of ctx.hosts) {
    const cmd = talkCommand(ctx, agent, h);
    if (!cmd) continue;
    if (!acts) acts = head.createDiv({ cls: "aos-aw-teamacts" });
    const b = acts.createEl("button", {
      cls: "aos-aw-btn aos-aw-talk", text: `❯_ talk to ${leadName}${ctx.hosts.length > 1 ? ` · ${h}` : ""}`,
      attr: { type: "button", title: `Start a ${HOST_LABEL[h]} session as ${leadName}: ${cmd}` },
    });
    b.addEventListener("click", () => ctx.term(cmd, h));
  }
}

function pausedBanner(host: HTMLElement, ctx: TeamsCtx, t: Team): void {
  const k = `pause:${t.id}`;
  const busy = ctx.busy(k);
  const bar = host.createDiv({ cls: "aos-aw-note is-warn aos-aw-paused" });
  bar.createSpan({ text: "This team is paused: no seat can be dispatched until it resumes." });
  const r = bar.createEl("button", { cls: "aos-aw-btn", text: busy ? "Resuming…" : "Resume", attr: { type: "button" } });
  r.disabled = busy;
  r.addEventListener("click", () => void ctx.act(k, pauseArgs(t.id, false)));
  errorLine(host, ctx.error(k));
}

/** Who is at work: a chip per member working (its live run's item and age) or blocked (the item it is blocked on), then
 *  how many are idle or paused. */
function nowStrip(host: HTMLElement, ctx: TeamsCtx, t: Team): void {
  const strip = host.createDiv({ cls: "aos-aw-now", attr: { role: "group", "aria-label": "Now" } });
  strip.createSpan({ cls: "aos-aw-nowlabel", text: "NOW" });
  const members = memberStatus(t);
  const busy = members.filter((m) => m.status === "working" || m.status === "blocked");
  for (const m of busy) {
    const name = m.name || m.id;
    const run = m.status === "working" ? t.live.find((x) => x.member === m.id) : undefined;
    const item = m.status === "blocked" ? t.board.find((it) => it.status === "blocked" && it.owners.includes(m.id))?.id ?? m.item : m.item;
    const title = run
      ? `${name} is running ${item ?? "a run"}${run.provider ? ` on ${run.provider}` : ""}${run.startedAt ? `, started ${run.startedAt}` : ""}`
      : `${name} is blocked${item ? ` on ${item}` : ""}`;
    const chip = strip.createSpan({ cls: `aos-aw-who is-${m.status}`, attr: { title } });
    chip.createSpan({ cls: `aos-aw-avatar${m.lead ? " is-lead" : ""}`, text: name.charAt(0).toUpperCase(), attr: { "aria-hidden": "true" } });
    chip.createSpan({ cls: "aos-aw-whoname", text: name });
    chip.createSpan({ cls: `aos-aw-dot ${memberTone(m.status)}`, attr: { "aria-hidden": "true" } });
    const what = [item ?? "", run?.startedAt ? since(run.startedAt, ctx.now) : ""].filter(Boolean).join(" · ");
    if (what) chip.createSpan({ cls: "aos-aw-whoitem", text: what });
  }
  const idle = members.filter((m) => m.status === "idle").length;
  const paused = members.filter((m) => m.status === "paused").length;
  const rest = [busy.length ? "" : "nobody working", idle ? `${idle} idle` : "", paused ? `${paused} paused` : ""].filter(Boolean).join(" · ");
  if (rest) strip.createSpan({ cls: "aos-aw-nowrest", text: rest });
}

/** The view bar: the views as a tablist, and room after it for the shown view's own controls (Items' list · board). A
 *  click picks a view; the arrows, Home and End move along the tabs and pick the one they land on, which keeps the
 *  keyboard (the tab puts the focus back on it after it redraws: data-focus). Returns the bar. */
function viewTabs(host: HTMLElement, t: Team, open: number, shown: TeamsView, onView: (v: TeamsView) => void): HTMLElement {
  const bar = host.createDiv({ cls: "aos-aw-viewbar" });
  const tabs = bar.createDiv({ cls: "aos-aw-views", attr: { role: "tablist", "aria-label": `${t.name} views` } });
  const els: HTMLElement[] = [];
  for (const v of TEAM_VIEWS) {
    const on = v.id === shown;
    const b = tabs.createEl("button", {
      cls: `aos-aw-view${on ? " is-active" : ""}`,
      attr: { type: "button", role: "tab", "aria-selected": String(on), tabindex: on ? "0" : "-1", "data-view": v.id, "data-focus": `view:${v.id}` },
    });
    b.createSpan({ cls: "aos-aw-viewlabel", text: v.label });
    if (v.id === "items" && open) b.createSpan({ cls: "aos-aw-viewcount", text: String(open), attr: { "aria-label": `${open} open` } });
    b.addEventListener("click", () => onView(v.id));
    els.push(b);
  }
  tabs.addEventListener("keydown", (e) => {
    const i = els.indexOf(e.target as HTMLElement);
    if (i < 0) return;
    const n = els.length;
    const j = ({ ArrowRight: (i + 1) % n, ArrowDown: (i + 1) % n, ArrowLeft: (i - 1 + n) % n, ArrowUp: (i - 1 + n) % n, Home: 0, End: n - 1 } as Record<string, number>)[e.key];
    if (j === undefined) return;
    e.preventDefault();
    els[j].focus();
    onView(TEAM_VIEWS[j].id);
  });
  return bar;
}

/** A team whose TEAM.md or board cannot be read: what is wrong, and the file to fix. */
function brokenCard(host: HTMLElement, ctx: TeamsCtx, t: Team): void {
  const file = t.errorFile ?? "TEAM.md";
  const box = host.createDiv({ cls: "aos-aw-note is-error" });
  box.createDiv({ text: `${TEAMS_DIR}/${t.id}/${file}: ${t.error}` });
  const open = box.createEl("button", { cls: "aos-aw-btn", text: `Open ${file}`, attr: { type: "button" } });
  open.addEventListener("click", () => ctx.openFile(`${TEAMS_DIR}/${t.id}/${file}`));
}
