// InteractPane.ts — the Agent Teams tab's Interact area (spec 2026-09-28-agent-teams-design D12): the team channel with its
// @mentions, a filter by item, "Talk to <lead>" per enabled host, and a message box to the lead. The box is data entry,
// which the settings rule allows; its text posts to the channel as the user, addressed @<lead>, through `aos team post`.
import { channelView, CHANNEL_WINDOW } from "../../data/teams";
import { postArgs } from "../../data/teamWriter";
import { TeamsCtx, postRow, errorLine, hostButtons, talkCommand, HOST_LABEL } from "./ui";

/** The most items the filter row offers: the ones posted about most recently. */
const FILTER_ITEMS = 8;

export function renderInteract(host: HTMLElement, ctx: TeamsCtx): void {
  const t = ctx.team;
  const lead = t.members.find((m) => m.id === t.lead);
  const leadName = lead?.name ?? t.lead;

  const bar = host.createDiv({ cls: "aos-at-interactbar" });
  hostButtons(bar, ctx, `Talk to ${leadName}`, (h) => talkCommand(ctx, lead?.agent ?? null, h),
    (h, cmd) => `Start a ${HOST_LABEL[h]} session as ${leadName}: ${cmd}`,
    ctx.hosts.length ? `${leadName}'s agent (${lead?.agent ?? "none"}) is not in the Agents list: sync it in the Agents tab` : "Enable Claude Code or Codex to talk to the lead");

  const recent: string[] = [];
  for (const p of [...t.channel].reverse()) if (p.item && !recent.includes(p.item)) recent.push(p.item);
  if (ctx.ui.channelItem && !recent.includes(ctx.ui.channelItem)) recent.unshift(ctx.ui.channelItem);
  if (recent.length) {
    const f = host.createDiv({ cls: "aos-nt-filters", attr: { role: "group", "aria-label": "Show posts about" } });
    const chip = (label: string, item: string | null) => {
      const on = ctx.ui.channelItem === item;
      const b = f.createEl("button", { cls: `aos-nt-chip${on ? " is-active" : ""}`, text: label, attr: { "aria-pressed": String(on) } });
      b.addEventListener("click", () => { ctx.ui.channelItem = item; ctx.render(); });
    };
    chip("All", null);
    for (const id of recent.slice(0, FILTER_ITEMS)) chip(id, id);
  }

  const posts = channelView(t, ctx.ui.channelItem);
  const list = host.createDiv({ cls: "aos-at-channel", attr: { role: "log", "aria-label": `${t.name} channel` } });
  if (!posts.length) list.createDiv({ cls: "aos-at-emptyline aos-dim", text: ctx.ui.channelItem ? `No posts on ${ctx.ui.channelItem} yet.` : "The channel is empty. Posts from the lead, its seats and you appear here." });
  const total = ctx.ui.channelItem ? t.channel.filter((p) => p.item === ctx.ui.channelItem).length : t.channel.length;
  if (total > CHANNEL_WINDOW) list.createDiv({ cls: "aos-dim aos-at-more", text: `the last ${CHANNEL_WINDOW} of ${total} posts; aos team tail ${t.id} -n ${total} shows them all` });
  for (const p of posts) postRow(list, t, p, ctx.now, !ctx.ui.channelItem);

  const key = `post:${t.id}`;
  const busy = ctx.busy(key);
  const form = host.createEl("form", { cls: "aos-at-compose" });
  const box = form.createEl("textarea", {
    cls: "aos-at-msg",
    attr: { rows: "2", placeholder: `Message @${t.lead}. Enter sends, Shift+Enter adds a line.`, "aria-label": `Message to ${leadName}`, maxlength: "3900" },
  });
  const draft = ctx.ui.drafts.get(t.id) ?? "";
  box.value = draft;
  box.disabled = busy;
  const send = form.createEl("button", { cls: "mod-cta aos-at-send", text: busy ? "Posting…" : "Send", attr: { type: "submit" } });
  send.disabled = busy || !draft.trim();
  box.addEventListener("input", () => { ctx.ui.drafts.set(t.id, box.value); send.disabled = busy || !box.value.trim(); });
  const submit = () => {
    const args = postArgs(t.id, t.lead, ctx.ui.drafts.get(t.id) ?? "");
    if (!args || busy) return;
    void ctx.act(key, args).then((ok) => { if (ok) { ctx.ui.drafts.delete(t.id); ctx.render(); } });
  };
  box.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); } });
  form.addEventListener("submit", (e) => { e.preventDefault(); submit(); });
  host.createDiv({ cls: "aos-dim aos-at-hint", text: `Posts as you. ${leadName} reads the channel on its next step; Talk to ${leadName} starts one now.` });
  errorLine(host, ctx.error(key));
}
