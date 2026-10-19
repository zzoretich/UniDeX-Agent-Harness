// DossierPane.ts — the centre pane's header (spaces-redesign D5): the name, the status pill (PR 3: the status menu,
// D18), the pin toggle (PR 3), the mono meta line (path, linked code folder, git), and the actions grouped on the left:
// Resume in Code as a split button (aria-haspopup), Terminal, Finder, More ⋯ (PR 3: Rename…, Pin, Set status…, Link
// code folder…, Draft workspace.md, Copy path, Archive…). A fresh clone's card sits under them (D15). Under it the
// Overview · Files tabs (D8).
import type { WorkspaceEntry } from "../../data/snapshot";
import { gitMetaParts, statusPill } from "../../data/spacesModel";
import { lastThread } from "../../data/hostSessions";
import { filterCounts, mapSummary } from "../../data/workspaceMaps";
import { button, entryAbs, entryPlace, moreMenuItems, primaryAction, splitMenuItems, statusDot, tilde, verbsOff, whyLine, type SpacesCtx } from "./ui";

export function renderDossier(host: HTMLElement, ctx: SpacesCtx, e: WorkspaceEntry): void {
  const head = host.createEl("header", { cls: "aos-spc-head" });
  const bar = head.createDiv({ cls: "aos-spc-titlebar" });
  // Focusable from code only: leaving the outside list through a Matches link lands here (spaces-redesign D21).
  bar.createEl("h1", { cls: "aos-spc-h1", text: e.label || e.name, attr: { title: e.name, tabindex: "-1", "data-spc-key": "title" } });
  const pill = statusPill(e);
  const off = verbsOff(e, ctx.world);
  const pillTitle = pill.auto ? `Status ${pill.word}, worked out from sessions and commits` : `Status ${pill.word}, set in workspace.md`;
  // The word as a class too: a paused pill is muted like idle, its hollow amber dot the only colour (D19: warn is
  // stalled's; a deliberately paused space is no alarm). PR 3: a listed workspace's pill opens the status menu (D18).
  const pillCls = `aos-spc-pill is-${pill.tone} is-${pill.word}`;
  const p = off
    ? bar.createSpan({ cls: pillCls, attr: { title: pillTitle } })
    : button(bar, `${pillCls} aos-spc-pillbtn`, null, {
      key: "status", title: `${pillTitle}: change it`, label: `Status: ${pill.word}${pill.auto ? ", automatic" : ""}. Change status`,
      attr: { "aria-haspopup": "menu", "aria-expanded": "false" },
    });
  statusDot(p, pill);
  p.createSpan({ cls: "aos-spc-pillword", text: pill.word });
  if (pill.auto) p.createSpan({ cls: "aos-spc-pillauto", text: "· auto" });
  if (!off) {
    const chev = p.createSpan({ cls: "aos-spc-chev" });
    ctx.setIcon(chev, "chevron-down");
    p.addEventListener("click", () => ctx.act.statusMenu());
  }
  if (!off) {
    // The pin mark is the toggle (D18): `pinned: true` in workspace.md, through aos workspace set. Pinned, it is the
    // filled mark PR 2 drew (.aos-spc-pin, "Pinned"); unpinned, an outline pin that pins.
    const pin = button(bar, `aos-spc-iconbtn aos-spc-pinbtn${e.pinned ? " aos-spc-pin is-on" : ""}`, null, {
      key: "pin", label: e.pinned ? "Pinned" : "Pin", title: e.pinned ? "Pinned in workspace.md: unpin" : "Pin it to the top of the list",
      attr: { "aria-pressed": String(!!e.pinned) },
    });
    ctx.setIcon(pin, "pin");
    pin.addEventListener("click", () => ctx.act.togglePin());
  } else if (e.pinned) {
    const pin = bar.createSpan({ cls: "aos-spc-pin", attr: { role: "img", "aria-label": "Pinned", title: "Pinned in workspace.md" } });
    ctx.setIcon(pin, "pin");
  }
  if (e.hidden) bar.createSpan({ cls: "aos-spc-tag", text: e.hiddenReason === "archived" ? "archived" : "_ folder" });

  // The meta line (D5, D24): ~-shortened path, the linked code folder, the branch · clean/dirty · short hash; only the
  // parts that carry a state are coloured (D19: "n changed" warn, "no remote" off).
  const meta = head.createDiv({ cls: "aos-spc-meta" });
  meta.createSpan({ cls: "aos-spc-metapath", text: tilde(entryAbs(e, ctx.vault), ctx.home), attr: { title: entryAbs(e, ctx.vault) } });
  const code = ctx.world.links[e.name] ?? e.repoPath ?? null;
  if (code) meta.createSpan({ cls: "aos-spc-metacode", text: `code → ${tilde(code, ctx.home)}`, attr: { title: "Terminals here start in this linked code folder" } });
  if (e.git?.kind === "vault") {
    const v = meta.createSpan({ cls: "aos-spc-metavault" });
    v.appendText("tracked by the vault");
    if (!code && ctx.world.workspaces.includes(e.name)) {
      v.appendText(" · ");
      const l = button(v, "aos-spc-linkbtn", "Link code folder…", { key: "meta-link", title: "Give this workspace its code folder: terminals here start there" });
      l.addEventListener("click", () => ctx.act.linkCodeFolder());
    }
  } else {
    const g = meta.createSpan({ cls: "aos-spc-metagit" });
    const parts = gitMetaParts(e.git) ?? [{ text: "no git", tone: null }];
    parts.forEach((part, i) => {
      if (i) g.appendText(" · ");
      if (part.tone) g.createSpan({ cls: `is-${part.tone}`, text: part.text });
      else g.appendText(part.text);
    });
  }

  renderActions(head, ctx, e);
  if (ctx.clone) renderClone(head, ctx, e);
}

/**
 * A fresh clone (D15): the clone line runs in a Code terminal; once it ends (its last step, `aos workspace stubs
 * --pin`, wrote workspace.md) the card offers "Start <host> here". No agent starts on its own in a fresh clone.
 */
function renderClone(head: HTMLElement, ctx: SpacesCtx, e: WorkspaceEntry): void {
  const c = ctx.clone;
  if (!c) return;
  const card = head.createDiv({ cls: "aos-spc-clone", attr: { role: "status" } });
  const text = card.createDiv({ cls: "aos-spc-clonetext" });
  text.createSpan({ text: c.done ? "Cloned " : "Cloning " });
  text.createSpan({ cls: "aos-spc-mono", text: c.url });
  text.createSpan({ text: c.done ? ` into ${e.label || e.name}.` : " in a Code terminal." });
  const acts = card.createDiv({ cls: "aos-spc-cloneacts" });
  if (c.host) {
    const label = c.host === "claude" ? "Claude Code" : "Codex";
    const go = button(acts, "aos-spc-btn aos-spc-primary aos-spc-small", `Start ${label} here`, {
      key: "clone-start", disabled: !c.done,
      title: c.done ? `A new ${label} session in this clone, in Code` : "Waiting for the clone line to end in Code",
    });
    go.addEventListener("click", () => { if (c.host) ctx.act.startHere(c.host); });
  }
  const dismiss = button(acts, "aos-spc-linkbtn", "Dismiss", { key: "clone-dismiss", title: "Hide this card; the workspace stays" });
  dismiss.addEventListener("click", () => ctx.act.dismissClone());
  if (!c.done) whyLine(card, "No agent starts on its own: the button turns on when the clone line ends (a failed clone leaves an empty workspace to archive).", { div: true });
}

function renderActions(head: HTMLElement, ctx: SpacesCtx, e: WorkspaceEntry): void {
  const acts = head.createDiv({ cls: "aos-spc-actions" });
  const main = primaryAction(ctx, e);
  const split = acts.createDiv({ cls: "aos-spc-split", attr: { role: "group", "aria-label": main.label } });
  const go = button(split, "aos-spc-btn aos-spc-primary", null, { key: "resume", title: main.title, disabled: main.disabled });
  const goIco = go.createSpan({ cls: "aos-spc-ico" });
  ctx.setIcon(goIco, "play");
  go.createSpan({ text: main.label });
  go.addEventListener("click", () => main.run?.());
  // The caret is off only when every row of its menu is (a hidden entry with no Sessions thread): a Codex-only vault
  // whose last thread is Claude Code's still starts a Codex session from it. With the main half off the pair reads as
  // one outlined control (styles.css .aos-spc-split:has(…:disabled)).
  const items = splitMenuItems(ctx, e);
  const allOff = items.every((i) => i.disabled);
  const caretTitle = allOff ? items.find((i) => i.detail)?.detail ?? "Nothing else starts here" : "Other ways to start";
  const caret = button(split, "aos-spc-btn aos-spc-primary aos-spc-caret", null, {
    key: "resume-menu", label: "Other ways to start", title: caretTitle, disabled: allOff, attr: { "aria-haspopup": "menu", "aria-expanded": "false" },
  });
  ctx.setIcon(caret, "chevron-down");
  caret.addEventListener("click", () => ctx.act.menu(caret, items, "Other ways to start"));

  const where = entryPlace(e, ctx.world);
  const term = button(acts, "aos-spc-btn", null, { key: "terminal", title: where.reason ?? `A shell in ${e.name} (its code folder when linked), in Code`, disabled: !where.place });
  const termIco = term.createSpan({ cls: "aos-spc-ico" });
  ctx.setIcon(termIco, "terminal");
  term.createSpan({ text: "Terminal" });
  term.addEventListener("click", () => ctx.act.terminal());

  const finder = button(acts, "aos-spc-btn", null, { key: "finder", title: "Open the workspace folder in Finder" });
  const finderIco = finder.createSpan({ cls: "aos-spc-ico" });
  ctx.setIcon(finderIco, "folder");
  finder.createSpan({ text: "Finder" });
  finder.addEventListener("click", () => ctx.act.finder());

  const more = button(acts, "aos-spc-btn aos-spc-iconbtn", null, { key: "more", label: "More actions", title: "More actions", attr: { "aria-haspopup": "menu", "aria-expanded": "false" } });
  ctx.setIcon(more, "ellipsis");
  more.addEventListener("click", () => ctx.act.menu(more, moreMenuItems(ctx, e), "More actions"));

  // A disabled button cannot take the focus and its title is not read: say why it is off where everyone sees it. The
  // pick-up card's *last* row already says it for a thread that cannot resume, so only a start that cannot run and an
  // off Terminal are named here, each reason once.
  const reasons = [main.disabled && !lastThread(e.sessions) ? main.reason : null, where.reason];
  for (const r of reasons.filter((x, i): x is string => !!x && reasons.indexOf(x) === i)) whyLine(head, r, { div: true, cls: "aos-spc-actwhy" });
}

/** Overview · Files (D8, D9): a tablist; Files carries the map's file count and how many are not described yet. */
export function renderViewTabs(host: HTMLElement, ctx: SpacesCtx): void {
  const tabs = host.createDiv({ cls: "aos-spc-tabs", attr: { role: "tablist", "aria-label": "Workspace views" } });
  const files = filterCounts(ctx.index).all;
  const undescribed = ctx.map ? mapSummary(ctx.map).undescribed : 0;
  for (const v of ["overview", "files"] as const) {
    const on = ctx.ui.centre === v;
    const b = button(tabs, `aos-spc-tab${on ? " is-on" : ""}`, null, {
      key: `tab:${v}`, attr: { role: "tab", "aria-selected": String(on), "aria-controls": "aos-spc-viewpanel", tabindex: on ? "0" : "-1" },
    });
    b.createSpan({ text: v === "overview" ? "Overview" : "Files" });
    if (v === "files" && files) b.createSpan({ cls: "aos-spc-tabcount", text: String(files) });
    if (v === "files" && undescribed) b.createSpan({ cls: "aos-spc-badge is-new", text: `${undescribed} undescribed` });
    b.addEventListener("click", () => {
      if (on) return;
      ctx.ui.centre = v;
      ctx.act.tree();
    });
  }
  tabs.addEventListener("keydown", (ev) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(ev.key)) return;
    ev.preventDefault();
    const next = ev.key === "ArrowLeft" || ev.key === "Home" ? "overview" : "files";
    if (next === ctx.ui.centre) return;
    // Focus the tab first: the redraw puts the focus back on the element with the same key.
    tabs.querySelector<HTMLElement>(`[data-spc-key="tab:${next}"]`)?.focus();
    ctx.ui.centre = next;
    ctx.act.tree();
  });
}
