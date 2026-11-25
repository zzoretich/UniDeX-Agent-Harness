// ItemsPane.ts — a team's Items (spec 2026-11-12-agent-workspace-design D8): a flat list in needs-me order (itemOrder:
// pending gate, blocked, working, other open, paused), each row its id, title, a strip with one segment per team stage
// (stageStrip), its state, who holds it now and its budget; done items folded last behind "n done", as the board's done
// toggle. A list · board toggle in the team pane's view bar brings back today's board (renderBoard). A row or a card
// opens the item's detail below (renderItemDetail), and so does ui.openItem when a gate card's item link names it.
import { BoardItem, Team, Tone, itemTone, usd } from "../../data/teams";
import { StripCell, itemOrder, stageStrip } from "../../data/workspace";
import { TeamsCtx, since } from "../teams/ui";
import { renderBoard, renderItemDetail } from "../teams/BoardPane";

export type ItemsMode = "list" | "board";
const MODES: ItemsMode[] = ["list", "board"];

/** What a strip segment says to a reader that cannot see its colour. */
const CELL_TEXT: Record<StripCell, string> = { done: "done", current: "here", gate: "gate waiting on you", blocked: "blocked here", todo: "to do" };

/** The list's key in ui.showDone: a board column's key is "<team>/<stage>", and a team id never holds a colon. */
const doneKey = (t: Team) => `list:${t.id}`;

const isPending = (it: BoardItem) => it.status === "gate" && it.gate?.state === "pending";

/** An item's state word and tone. A gate that is not pending waits on nobody: the item is an ordinary open one. */
function itemState(it: BoardItem): { label: string; tone: Tone } {
  if (isPending(it)) return { label: `${it.gate!.name} gate`, tone: "is-gate" };
  if (it.status === "gate") return { label: "open", tone: "is-neutral" };
  return { label: it.status || "open", tone: itemTone(it) };
}

/** The list · board toggle, drawn into `bar` (the team pane's view bar): a pick asks for the mode it names. */
export function renderItemsToggle(bar: HTMLElement, mode: ItemsMode, onMode: (m: ItemsMode) => void): void {
  const g = bar.createDiv({ cls: "aos-aw-itemsmode", attr: { role: "group", "aria-label": "Show items as" } });
  for (const m of MODES) {
    const on = m === mode;
    const b = g.createEl("button", {
      cls: `aos-aw-mode${on ? " is-active" : ""}`, text: m,
      attr: { type: "button", "aria-pressed": String(on), "data-mode": m, "data-focus": `items-mode:${m}`, title: m === "list" ? "Items as a list, what needs you first" : "Items as a board, one column per stage" },
    });
    b.addEventListener("click", () => { if (m !== mode) onMode(m); });
  }
}

/**
 * The Items view in `mode`. `bar`, when given, is where the list · board toggle goes (the team pane passes its view bar);
 * without it the toggle heads `host`.
 */
export function renderItems(host: HTMLElement, ctx: TeamsCtx, mode: ItemsMode, onMode: (m: ItemsMode) => void, bar: HTMLElement = host): void {
  renderItemsToggle(bar, mode, onMode);
  if (mode === "board") { renderBoard(host, ctx); return; }
  const t = ctx.team;
  if (!t.board.length) {
    const lead = t.members.find((m) => m.id === t.lead)?.name ?? "the lead";
    host.createDiv({ cls: "aos-aw-empty aos-aw-dim", text: `No work items yet. The lead adds them with aos team put: tell ${lead} what to build in Channel.` });
    return;
  }
  const { open, done } = itemOrder(t);
  const list = host.createDiv({ cls: "aos-aw-items", attr: { role: "group", "aria-label": `${t.name} items` } });
  for (const it of open) itemRow(list, ctx, t, it);
  if (done.length) {
    const k = doneKey(t);
    const shown = ctx.ui.showDone.has(k);
    const tog = list.createEl("button", {
      cls: "aos-aw-donetoggle", text: shown ? `hide ${done.length} done` : `${done.length} done`,
      attr: { type: "button", "aria-expanded": String(shown), "data-focus": "items-done" },
    });
    tog.addEventListener("click", () => { if (shown) ctx.ui.showDone.delete(k); else ctx.ui.showDone.add(k); ctx.render(); });
    if (shown) for (const it of done) itemRow(list, ctx, t, it);
  }
  const it = t.board.find((i) => i.id === ctx.ui.openItem);
  if (it) renderItemDetail(host, ctx, t, it);
}

function itemRow(list: HTMLElement, ctx: TeamsCtx, t: Team, it: BoardItem): void {
  const open = ctx.ui.openItem === it.id;
  const state = itemState(it);
  const row = list.createDiv({
    cls: `aos-aw-item${open ? " is-open" : ""}${it.status === "done" ? " is-done" : ""}${isPending(it) ? " is-gate" : ""}`,
    attr: {
      role: "button", tabindex: "0", "aria-expanded": String(open), "data-focus": `item:${it.id}`,
      "aria-label": `${it.id}${it.title ? `: ${it.title}` : ""}, ${state.label}`,
    },
  });
  row.createSpan({ cls: "aos-aw-itemid", text: it.id });
  row.createSpan({ cls: "aos-aw-itemtitle", text: it.title, attr: it.title ? { title: it.title } : {} });

  const cells = stageStrip(t, it).map((c) => (c === "gate" && !isPending(it) ? "current" : c));
  const said = t.stages.map((s, i) => `${s}: ${CELL_TEXT[cells[i]]}`);
  const strip = row.createSpan({ cls: "aos-aw-strip", attr: { role: "img", "aria-label": said.join(", ") } });
  cells.forEach((c, i) => strip.createSpan({ cls: `aos-aw-seg is-${c}`, attr: { title: said[i] } }));
  row.createSpan({ cls: `aos-aw-itemstate ${state.tone}`, text: state.label });

  // Who holds it now: a live run's member, provider and age; else its owners.
  const holder = row.createSpan({ cls: "aos-aw-holder" });
  const name = (id: string) => t.members.find((m) => m.id === id)?.name ?? id;
  const live = t.live.filter((m) => m.item === it.id);
  for (const m of live) {
    const run = holder.createSpan({ cls: "aos-aw-live", attr: { title: `running now: ${m.run}, started ${m.startedAt ?? "?"}` } });
    run.createSpan({ cls: "aos-aw-livedot", attr: { "aria-hidden": "true" } });
    run.createSpan({ text: `${name(m.member)} · ${m.provider ?? "?"} · ${since(m.startedAt, ctx.now)}` });
  }
  if (!live.length) {
    if (it.owners.length) holder.setText(it.owners.map(name).join(", "));
    else { holder.addClass("aos-aw-dim"); holder.setText("–"); holder.setAttr("title", "nobody holds it"); }
  }
  row.createSpan({ cls: "aos-aw-money", text: `${usd(it.budget.spentUsd)} / ${usd(it.budget.usd)}`, attr: { title: "spent of its phase budget" } });

  const toggle = () => { ctx.ui.openItem = open ? null : it.id; ctx.render(); };
  row.addEventListener("click", toggle);
  row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
}
