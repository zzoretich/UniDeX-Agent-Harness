// ui.ts — what the Agent Teams tab's panes share: the context the tab hands each pane, and small render helpers. Kept
// apart from AgentTeamsTab.ts so the panes never import the tab (a cycle esbuild would resolve at runtime, by luck).
import type { App } from "obsidian";
import type { AgentsCache } from "../../data/agents";
import type { SessionHost } from "../../data/aosConfig";
import type { Presets } from "../../data/teamWriter";
import { Team, BoardItem, Post, Tone, TEAMS_DIR, sessionCommand, redirectPrompt, shq, splitMentions } from "../../data/teams";

export type TeamsView = "board" | "roster" | "interact" | "manage";
export const VIEWS: { id: TeamsView; label: string }[] = [
  { id: "board", label: "Board" }, { id: "roster", label: "Roster" }, { id: "interact", label: "Interact" }, { id: "manage", label: "Manage" },
];
export const HOST_LABEL: Record<SessionHost, string> = { claude: "Claude Code", codex: "Codex" };

/** What the tab remembers between renders (the files are the state; this is only the user's place in them). */
export interface TeamsUiState {
  team: string | null;
  view: TeamsView;
  gateUsd: Map<string, number>;     // "<team>/<item>" → the budget picked on its gate card
  budgetUsd: Map<string, number>;   // "<team>/<item>" → the budget picked in the item's detail
  openItem: string | null;          // the board item whose detail is open
  showDone: Set<string>;            // "<team>/<stage>" columns showing their done items
  channelItem: string | null;       // the Interact filter
  drafts: Map<string, string>;      // team id → its unsent message to the lead (never carried to another team)
  addPick: Map<string, string>;     // team id → the agent picked in "Add a member", kept across redraws until it is added
}

export interface Confirm { title: string; message: string; cta: string }

export interface TeamsCtx {
  app: App;
  teams: Team[];
  team: Team;
  agents: AgentsCache;
  hosts: SessionHost[];
  presets: Presets | null;
  /** How a terminal session runs `aos team` against this tab's vault (teamCommand). */
  teamCmd: string;
  /** Leads a host's command so it sees the folder this plugin uses for that host (envPrefix); usually empty. */
  hostEnv: Record<SessionHost, string>;
  now: Date;
  ui: TeamsUiState;
  busy(key: string): boolean;
  error(key: string): string | null;
  /** Runs `aos team <args>` (after `confirm`, when given), shows its verdict under `key`, then re-reads. True on success. */
  act(key: string, args: string[], confirm?: Confirm): Promise<boolean>;
  /** Opens a terminal running `command`; `host` is the agent it starts (its dot in the Term list). */
  term(command: string, host?: SessionHost): void;
  render(): void;
  select(team: string, view?: TeamsView, item?: string | null): void;
  openFile(vaultPath: string): void;
}

export const itemKey = (t: Team, it: BoardItem) => `${t.id}/${it.id}`;

/** A status chip: the Pulse tab's chip and dot, in the tab's tone. */
export function statusChip(parent: HTMLElement, tone: Tone, text: string, title?: string): HTMLElement {
  const el = parent.createSpan({ cls: `aos-pulse-chip aos-at-chip ${tone}`, attr: title ? { title } : {} });
  el.createSpan({ cls: "aos-pulse-dot" });
  el.createSpan({ text });
  return el;
}

const PROVIDER_PILL: Record<string, string> = { claude: "aos-pill-cyan", codex: "aos-pill-amber" };
export function providerPill(parent: HTMLElement, provider: string | null): void {
  const p = provider ?? "?";
  parent.createSpan({
    cls: `aos-pill ${PROVIDER_PILL[p] ?? "aos-pill-dim"} aos-at-provider`, text: p,
    attr: { title: p === "opposite" ? "runs on whichever provider did not build the item" : `runs on ${p === "codex" ? "Codex" : p === "claude" ? "Claude Code" : p}` },
  });
}

export function errorLine(parent: HTMLElement, text: string | null): void {
  if (text) parent.createDiv({ cls: "aos-at-error", text, attr: { role: "alert" } });
}

/** "12m", "3h", "2d": how long since `iso`. */
export function since(iso: string | null, now: Date): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "?";
  const m = Math.max(0, Math.floor((now.getTime() - t) / 60000));
  if (m < 60) return `${m}m`;
  if (m < 48 * 60) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
}

/** A post's time: HH:MM today, else MM-DD HH:MM, local. */
export function postTime(iso: string, now: Date): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const hm = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  return d.toDateString() === now.toDateString() ? hm : `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hm}`;
}

const KIND_PILL: Record<string, string> = {
  blocker: "aos-pill-rose", gate: "aos-pill-amber", question: "aos-pill-amber", done: "aos-pill-green", handoff: "aos-pill-cyan", assign: "aos-pill-cyan",
};

/** Text with each @mention marked; a mention of a member or the user is highlighted. */
export function mentionText(parent: HTMLElement, text: string, t: Team): void {
  for (const part of splitMentions(text, t.members.map((m) => m.id))) {
    if (part.mention) parent.createSpan({ cls: `aos-at-mention${part.known ? " is-known" : ""}`, text: part.text });
    else parent.appendText(part.text);
  }
}

/** One channel post: time, who, kind, item, text. */
export function postRow(parent: HTMLElement, t: Team, p: Post, now: Date, showItem = true): void {
  const row = parent.createDiv({ cls: `aos-at-post is-${p.kind}` });
  const meta = row.createDiv({ cls: "aos-at-postmeta" });
  meta.createSpan({ cls: "aos-at-posttime aos-dim", text: postTime(p.ts, now), attr: { title: p.ts } });
  const who = p.from === "user" ? "you" : t.members.find((m) => m.id === p.from)?.name ?? p.from;
  meta.createSpan({ cls: `aos-at-from${p.from === t.lead ? " is-lead" : p.from === "user" ? " is-user" : p.from === "dispatch" ? " is-dispatch" : ""}`, text: who });
  if (p.kind !== "note") meta.createSpan({ cls: `aos-pill ${KIND_PILL[p.kind] ?? "aos-pill-dim"} aos-at-kind`, text: p.kind });
  if (showItem && p.item) meta.createSpan({ cls: "aos-at-itemtag aos-dim", text: p.item });
  mentionText(row.createDiv({ cls: "aos-at-posttext" }), p.text, t);
}

/**
 * One button per enabled host that has a command; a single host drops the host name from the label. Nothing renders
 * when no host has one, unless `none` says why.
 */
export function hostButtons(parent: HTMLElement, ctx: TeamsCtx, label: string, commandFor: (h: SessionHost) => string | null, title: (h: SessionHost, cmd: string) => string, none?: string, { quiet = false } = {}): void {
  const list = ctx.hosts.map((h) => ({ h, cmd: commandFor(h) })).filter((x): x is { h: SessionHost; cmd: string } => !!x.cmd);
  if (!list.length) { if (none) parent.createSpan({ cls: "aos-dim aos-at-hint", text: none }); return; }
  for (const { h, cmd } of list) {
    // Quiet: a row of many members gets the Agents tab's "❯_ claude" links, not a wall of buttons.
    const text = quiet ? `❯_ ${h}` : ctx.hosts.length > 1 ? `${label} ❯_ ${h}` : `${label} ❯_`;
    const b = quiet ? parent.createEl("a", { cls: "aos-link", text, href: "#", attr: { title: title(h, cmd) } }) : parent.createEl("button", { cls: "aos-ws-action aos-at-btn", text, attr: { title: title(h, cmd) } });
    b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); ctx.term(cmd, h); });
  }
}

/** Talk to a member: its agent's own session on `host`, or null when that host does not have the agent. */
export function talkCommand(ctx: TeamsCtx, agent: string | null, host: SessionHost): string | null {
  return sessionCommand(ctx.agents, agent, host, undefined, ctx.hostEnv[host]);
}

/** Redirect: the lead's session with the gate's context; a plain session carries the same prompt when the lead's agent
 *  is missing on that host, so the redirect can still be recorded. */
export function redirectCommand(ctx: TeamsCtx, t: Team, it: BoardItem, host: SessionHost): string {
  const prompt = redirectPrompt(t, it, ctx.teamCmd);
  const lead = t.members.find((m) => m.id === t.lead);
  return sessionCommand(ctx.agents, lead?.agent ?? null, host, prompt, ctx.hostEnv[host]) ?? `${ctx.hostEnv[host]}${host} ${shq(prompt)}`;
}

/** After an Approve or a paused item's budget raise: the one session that hands the lead its next step. The lead's own
 *  provider when that host is enabled and has its agent, else the first enabled host that has it, else a `plain` session
 *  on the first of those hosts, told which lead to act as and where the team's rules are; null when no host is enabled. */
export function nextStepCommand(ctx: TeamsCtx, t: Team, prompt: string): { host: SessionHost; command: string; plain: boolean } | null {
  const lead = t.members.find((m) => m.id === t.lead);
  const order = [...ctx.hosts].sort((a, b) => Number(b === lead?.provider) - Number(a === lead?.provider));
  for (const host of order) {
    const command = sessionCommand(ctx.agents, lead?.agent ?? null, host, prompt, ctx.hostEnv[host]);
    if (command) return { host, command, plain: false };
  }
  const host = order[0];
  if (!host) return null;
  // Names come from TEAM.md as typed; the whole prompt is one shq word, so the shell passes them to the session as text.
  const role = `Act as ${lead?.name ?? t.lead} (${t.lead}), the lead of the ${t.id} team: `
    + `${lead?.agent ? `its agent, ${lead.agent}, is not installed for this host, so ` : ""}read the team's rules in ${TEAMS_DIR}/${t.id}/TEAM.md first. `;
  return { host, command: `${ctx.hostEnv[host]}${host} ${shq(role + prompt)}`, plain: true };
}
