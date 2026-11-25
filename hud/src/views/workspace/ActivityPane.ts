// ActivityPane.ts — a team's Activity (spec 2026-11-12-agent-workspace-design D7): one newest-first feed derived from the
// team's own files by activityOf (finished and live runs, board history, channel posts), never a model call. The first
// ACTIVITY_PAGE events, then "older" asks the tab for the next page; the tab keeps the page count per team.
import { ACTIVITY_PAGE, activityOf } from "../../data/workspace";
import { TeamsCtx, since } from "../teams/ui";

/** `page` pages of the feed (1 = the first ACTIVITY_PAGE events); `onMore` shows one page more. */
export function renderActivity(host: HTMLElement, ctx: TeamsCtx, page: number, onMore: () => void): void {
  const events = activityOf(ctx.team);
  if (!events.length) {
    host.createDiv({ cls: "aos-aw-empty aos-aw-dim", text: "No activity yet: runs, board moves and channel posts show here as they happen." });
    return;
  }
  const shown = events.slice(0, Math.max(1, page) * ACTIVITY_PAGE);
  const feed = host.createDiv({ cls: "aos-aw-feed", attr: { role: "list", "aria-label": `${ctx.team.name} activity` } });
  for (const e of shown) {
    const row = feed.createDiv({ cls: `aos-aw-event is-${e.kind}`, attr: { role: "listitem" } });
    row.createSpan({ cls: "aos-aw-evtime", text: since(e.ts, ctx.now), attr: { title: e.ts } });
    row.createSpan({ cls: `aos-aw-dot ${e.tone}`, attr: { "aria-hidden": "true" } });
    row.createSpan({ cls: "aos-aw-evtext", text: e.text });
  }
  const left = events.length - shown.length;
  if (left > 0) {
    const n = Math.min(left, ACTIVITY_PAGE);
    const more = host.createEl("button", {
      cls: "aos-aw-older", text: "older activity ▸",
      attr: { type: "button", "data-focus": "older", title: `Show ${n} more of the ${left} older event${left === 1 ? "" : "s"}` },
    });
    more.addEventListener("click", onMore);
  }
}
