// PickupCard.ts — "pick up where you left off" (spaces-redesign D6, the Rows treatment): *last* (host · age — title,
// with the resume line as a hint, D7), *now* (the handoff's Now line), *next* (bold), *read* (the insight in one line,
// "suggests: …", model · age and ↻). Each row names its source or shows its empty state (Mechanics › PR 2).
import type { WorkspaceEntry } from "../../data/snapshot";
import { pickupFor } from "../../data/spacesModel";
import type { PickupRow } from "../../data/spacesModel";
import { button, hostDot, mappable, targetFor, typedCommand, whyLine, HIDDEN_MAP_TEXT, type SpacesCtx } from "./ui";

export function renderPickup(host: HTMLElement, ctx: SpacesCtx, e: WorkspaceEntry): void {
  const p = pickupFor(e, { now: ctx.now, provider: ctx.provider });
  const card = host.createEl("section", { cls: "aos-spc-pickup", attr: { "aria-label": "Pick up" } });
  const head = card.createDiv({ cls: "aos-spc-pickhead" });
  head.createSpan({ cls: "aos-spc-label", text: "PICK UP" });
  head.createSpan({ cls: "aos-spc-grow" });
  if (p.header) head.createSpan({ cls: "aos-spc-src", text: p.header });
  const grid = card.createDiv({ cls: "aos-spc-pickgrid" });

  // last
  const last = row(grid, "last");
  if (p.last.session && p.last.host) {
    const who = last.createSpan({ cls: "aos-spc-who" });
    hostDot(who, p.last.host);
    who.appendText(p.last.host);
    last.appendText(`${p.last.age ? ` · ${p.last.age}` : ""} — “${p.last.title ?? "Untitled session"}”`);
    if (p.last.source) last.createSpan({ cls: "aos-spc-src", text: ` ${p.last.source}` });
    if (p.last.resume) {
      const t = targetFor(ctx, e, p.last.resume);
      const hint = last.createDiv({ cls: "aos-spc-hint" });
      if (t.kind === "terminal") {
        const line = ctx.resumeLine(t.host, t.id, t.cwd);
        // Paths under home read ~/… on screen (Codex's -C folder); the title keeps the full line.
        if (line) hint.createSpan({ cls: "aos-spc-mono", text: `↳ ${typedCommand(line, ctx.home)}`, attr: { title: line.trim() } });
        hint.createSpan({ cls: "aos-spc-hinttext", text: t.hint });
      } else if (t.kind === "sessions") hint.createSpan({ cls: "aos-spc-hinttext", text: t.hint });
      else whyLine(hint, t.reason);
    }
  } else empty(last, p.last.empty);

  // now
  const now = row(grid, "now");
  if (p.now.text) {
    now.appendText(p.now.text);
    if (p.now.source && p.now.source !== p.header) now.createSpan({ cls: "aos-spc-src", text: ` ${p.now.source}` });
  } else empty(now, p.now.empty);

  // next
  const next = row(grid, "next");
  if (p.next.text) {
    next.createSpan({ cls: "aos-spc-next", text: p.next.text });
    if (p.next.source) next.createSpan({ cls: "aos-spc-src", text: ` ${p.next.source}` });
  } else empty(next, p.next.empty);

  // read
  const read = row(grid, "read");
  read.addClass("aos-spc-read");
  const text = read.createSpan({ cls: "aos-spc-readtext" });
  if (p.read.text) {
    text.appendText(p.read.text);
    if (p.read.suggests) text.createSpan({ cls: "aos-spc-suggests", text: ` suggests: ${p.read.suggests}` });
  } else empty(text, p.read.empty);
  if (p.read.source) read.createSpan({ cls: "aos-spc-src aos-spc-readsrc", text: p.read.source });
  renderRegen(read, ctx, e, p.read);
}

function row(grid: HTMLElement, key: PickupRow["key"]): HTMLElement {
  grid.createSpan({ cls: "aos-spc-pickkey", text: key });
  return grid.createDiv({ cls: `aos-spc-pickval is-${key}`, attr: { "data-row": key } });
}

function empty(parent: HTMLElement, text: string): void {
  parent.createSpan({ cls: "aos-spc-emptyval", text });
}

/**
 * ↻ for the read: regenerates the insight (today's regen). Under provider `none` the runtime writes a heuristic read,
 * so it stays on there and says so (pickupFor's refreshNote); only an archived or `_` folder, which the scan does not
 * read, is off.
 */
function renderRegen(parent: HTMLElement, ctx: SpacesCtx, e: WorkspaceEntry, read: { refreshNote: string | null }): void {
  const off = !mappable(e);
  const title = off ? HIDDEN_MAP_TEXT : read.refreshNote ? `Regenerate the read. ${read.refreshNote}` : "Regenerate the read";
  const b = button(parent, "aos-spc-iconbtn aos-spc-regen", null, { key: "regen", label: "Regenerate the read", title, disabled: off });
  ctx.setIcon(b, "refresh-cw");
  b.addEventListener("click", () => ctx.act.regen());
}
