// HistoryPane.ts — HISTORY in the right pane (spaces-redesign D10): All · Sessions · Commits; sessions with their host
// dot, title, age and a Resume per thread decided by resumeTarget (D7, D31, D32: off with the reason, which shows);
// commits with their short hash and subject from the workspace's repo or its linked code folder; "All n in Sessions →".
import type { WorkspaceEntry } from "../../data/snapshot";
import { HISTORY_FILTERS, historyFor, type HistoryFilter, type HistoryItem } from "../../data/spacesModel";
import { button, dot, hostDot, sectionHead, segmented, sessionsFooter, targetFor, whyLine, type SpacesCtx } from "./ui";

const FILTER_TEXT: Record<HistoryFilter, string> = { all: "All", sessions: "Sessions", commits: "Commits" };

export function renderHistory(host: HTMLElement, ctx: SpacesCtx, e: WorkspaceEntry): void {
  const sec = host.createEl("section", { cls: "aos-spc-history", attr: { "aria-labelledby": "aos-spc-history-h" } });
  const head = sectionHead(sec, "HISTORY", { id: "aos-spc-history-h", focusable: true });
  head.createSpan({ cls: "aos-spc-grow" });
  segmented(head, "Show", HISTORY_FILTERS.map((f) => ({ id: f, text: FILTER_TEXT[f] })), ctx.ui.history, "hfilter", (f) => {
    ctx.ui.history = f;
    ctx.act.redraw(["right"]);
  });

  const items = historyFor(e, ctx.ui.history, { now: ctx.now, home: ctx.home });
  const list = sec.createDiv({ cls: "aos-spc-hlist" });
  // A reason shows once, under the first row it turns off (three Codex threads on a Claude-only vault share one); every
  // disabled Resume keeps it in its title.
  const said = new Set<string>();
  for (const it of items) renderItem(list, ctx, e, it, said);
  const sessions = items.filter((i) => i.kind === "session").length;
  if (ctx.ui.history !== "commits" && !sessions) list.createEl("p", { cls: "aos-spc-emptyval", text: "No Claude Code or Codex sessions here yet." });
  if (ctx.ui.history === "commits" && !items.length) {
    list.createEl("p", { cls: "aos-spc-emptyval", text: e.git ? "No commits yet." : "No git here: link a code folder to see its commits." });
  }

  const foot = sessionsFooter(ctx.threads, e.name, ctx.sessionsAvailable);
  if (foot && !foot.disabled) {
    const b = button(sec, "aos-spc-linkbtn aos-spc-more", foot.text, { key: "history-sessions", title: "Open this workspace's threads in Sessions" });
    b.addEventListener("click", () => ctx.act.openSessions(null));
  }
}

function renderItem(list: HTMLElement, ctx: SpacesCtx, e: WorkspaceEntry, it: HistoryItem, said: Set<string>): void {
  const s = it.session;
  const isTarget = !!ctx.ui.target.thread && !!s && (s.thread === ctx.ui.target.thread || s.id === ctx.ui.target.thread);
  // The thread a link pointed at (D12): marked for assistive technology and in words, not by its tint alone.
  const row = list.createDiv({ cls: `aos-spc-hrow is-${it.kind}${isTarget ? " is-target" : ""}`, attr: isTarget ? { "aria-current": "true" } : {} });
  if (it.kind === "session" && it.host) hostDot(row, it.host);
  else dot(row, "commit", "Commit", { cls: "aos-spc-commitmark" });
  const body = row.createDiv({ cls: "aos-spc-hbody" });
  body.createSpan({ cls: "aos-spc-htitle", text: it.title, attr: { title: s?.viaText ? `${it.title}\n${s.viaText}` : it.title } });
  body.createSpan({ cls: "aos-spc-hmeta", text: it.meta });
  if (isTarget) row.createSpan({ cls: "aos-spc-tag aos-spc-targettag", text: "linked" });
  if (!it.resume) return;
  const t = targetFor(ctx, e, it.resume);
  const label = t.kind === "sessions" ? "Open" : "Resume";
  const b = button(row, "aos-spc-btn aos-spc-small aos-spc-hresume", label, {
    key: `resume:${it.key}`,
    label: t.kind === "sessions" ? `Open “${it.title}” in Sessions` : `Resume “${it.title}” in Code`,
    title: t.disabled ? t.reason : t.hint,
    disabled: t.disabled,
  });
  b.addEventListener("click", () => ctx.act.resume(it.resume!));
  if (t.disabled && !said.has(t.reason)) {
    said.add(t.reason);
    whyLine(body, t.reason);
  }
}
