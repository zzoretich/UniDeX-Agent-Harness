// Tree.ts — the Agent Workspace's left tree (spec 2026-11-12-agent-workspace-design D4, D12, §4.2): the rows
// workspaceTree builds, drawn as an ARIA tree. ↑↓ walk the rows, → opens a folded team or section (on an open one it
// steps to the first row under it), ← folds an open one (on anything else it goes up to the row it sits under), Enter
// selects a row (on a section: folds or opens it). Rows are drawn by index: an agent seated on two teams, or a seated
// plugin agent, has a row under each with one key, and every row whose key is the selection is highlighted. No runtime
// import of obsidian here, so the pure helpers are unit-tested.
import type { NodeKey, TreeRow } from "../../data/workspace";

/** The row workspaceTree puts under BENCH when there is no agents cache: a dim note, never folded or selected. */
export const UNSCANNED: NodeKey = "bench:unscanned";

/** A row as the tree shows it: `folded` marks a team whose members and sub-teams are hidden. */
export type ShownRow = TreeRow & { folded?: boolean };

export interface TreeOptions {
  selected: NodeKey;
  onSelect(k: NodeKey): void;
  onFold(k: NodeKey): void;
  /** A row's tooltip (the broken team's error), when it has one. */
  describe?(r: TreeRow): string | null;
  /** Whether the agents list was ever scanned (agents.json scannedAt). Until it is, no member's agent can be called
   *  missing, so an agentless member's row carries no "no agent" mark. */
  scanned?: boolean;
}

/** Hides what sits under each folded team (its members, its sub-teams and theirs): the rows after it that are deeper,
 *  up to the next row at its depth or above. A filter shows every match, so it ignores these folds as workspaceTree
 *  ignores the sections'. A team with nothing under it is never marked folded. */
export function foldTeams(rows: TreeRow[], folded: ReadonlySet<NodeKey>, query = ""): ShownRow[] {
  if (query.trim()) return rows;
  const out: ShownRow[] = [];
  let hideBelow: number | null = null;
  rows.forEach((r, i) => {
    if (hideBelow !== null) {
      if (r.depth > hideBelow) return;
      hideBelow = null;
    }
    const under = (rows[i + 1]?.depth ?? -1) > r.depth;
    if (r.kind === "team" && under && folded.has(r.key)) {
      out.push({ ...r, folded: true });
      hideBelow = r.depth;
    } else out.push(r);
  });
  return out;
}

/** The index of the row that `rows[i]` sits under (the nearest row before it at a smaller depth), or -1. */
export function parentOf(rows: readonly TreeRow[], i: number): number {
  const d = rows[i]?.depth ?? 0;
  for (let j = i - 1; j >= 0; j--) if (rows[j].depth < d) return j;
  return -1;
}

/** Whether a row has rows under it right now, whether it can fold or open, and whether it can be selected. */
export function rowState(rows: readonly ShownRow[], i: number): { open: boolean; foldable: boolean; pickable: boolean; note: boolean } {
  const r = rows[i];
  const open = (rows[i + 1]?.depth ?? -1) > r.depth;
  const note = r.key === UNSCANNED;
  // A section with nothing in it has nothing to fold; a team folds when it has members or sub-teams.
  const foldable = !note && (r.kind === "section" ? open || (r.count ?? 0) > 0 : r.kind === "team" ? open || !!r.folded : false);
  return { open, foldable, pickable: !note && r.kind !== "section", note };
}

/** Which row has the keyboard, by its key and which of that key's rows it is (keys repeat), when one in `host` has it. */
export function focusedRow(host: HTMLElement): { key: NodeKey; nth: number } | null {
  const el = host.ownerDocument.activeElement;
  if (!(el instanceof HTMLElement) || !host.contains(el) || !el.dataset.key) return null;
  const key = el.dataset.key;
  const same = Array.from(host.querySelectorAll<HTMLElement>(".aos-aw-row")).filter((r) => r.dataset.key === key);
  return { key, nth: Math.max(0, same.indexOf(el)) };
}

/** Gives the keyboard back to that row after a redraw, when it is still shown. */
export function focusRow(host: HTMLElement, at: { key: NodeKey; nth: number } | null): void {
  if (!at) return;
  const same = Array.from(host.querySelectorAll<HTMLElement>(".aos-aw-row")).filter((r) => r.dataset.key === at.key);
  (same[at.nth] ?? same[0])?.focus({ preventScroll: false });
}

export function renderTree(host: HTMLElement, rows: ShownRow[], o: TreeOptions): void {
  const keep = focusedRow(host);
  host.empty();
  host.setAttr("role", "tree");
  const els: (HTMLElement | null)[] = [];
  let stop: HTMLElement | null = null;
  let first: HTMLElement | null = null;

  rows.forEach((r, i) => {
    const s = rowState(rows, i);
    const on = s.pickable && r.key === o.selected;
    const cls = ["aos-aw-row", `is-${r.kind}`];
    if (r.tone) cls.push(r.tone);
    if (r.broken) cls.push("is-broken");
    if (on) cls.push("is-selected");
    if (s.note) cls.push("is-note");
    const el = host.createDiv({ cls: cls.join(" "), attr: { role: "treeitem", "data-key": r.key, "data-kind": r.kind, "aria-level": String(r.depth + 1) } });
    el.style.setProperty("--aos-aw-depth", String(r.depth));
    const title = o.describe?.(r);
    if (title) el.setAttr("title", title);
    if (s.note) {
      el.setAttr("aria-disabled", "true");
      el.createSpan({ cls: "aos-aw-label", text: r.label });
      els.push(null);
      return;
    }
    el.setAttr("tabindex", "-1");
    if (s.pickable) el.setAttr("aria-selected", String(on));
    if (s.foldable) el.setAttr("aria-expanded", String(s.open));
    // The chevron: a fold toggle on its own for a team, whose row click selects it.
    const chev = el.createSpan({ cls: "aos-aw-chev", text: s.foldable ? (s.open ? "▾" : "▸") : "", attr: { "aria-hidden": "true" } });
    if (s.foldable && r.kind === "team") chev.addEventListener("click", (e) => { e.stopPropagation(); o.onFold(r.key); });
    if (r.kind === "team" || r.kind === "member") el.createSpan({ cls: `aos-aw-dot ${r.tone ?? "is-neutral"}`, attr: { "aria-hidden": "true" } });
    el.createSpan({ cls: "aos-aw-label", text: r.label });
    if (r.lead) el.createSpan({ cls: "aos-aw-lead", text: "lead" });
    if (r.kind === "member" && r.key.startsWith("member:") && o.scanned !== false) el.createSpan({ cls: "aos-aw-noagent", text: "no agent", attr: { title: "No agent of yours has this name: its seat points at a missing agent" } });
    if (r.broken) el.createSpan({ cls: "aos-aw-broken", text: "!", attr: { "aria-label": "could not be read" } });
    if (r.count !== undefined && (r.kind === "section" || r.count > 0)) el.createSpan({ cls: "aos-aw-count", text: String(r.count) });
    el.addEventListener("click", () => {
      if (s.pickable) o.onSelect(r.key);
      else if (s.foldable) o.onFold(r.key);
    });
    els.push(el);
    first ??= el;
    if (on && !stop) stop = el;
  });
  // One tab stop: the selected row (its first, when its key repeats), else the first row.
  ((stop ?? first) as HTMLElement | null)?.setAttr("tabindex", "0");

  host.onkeydown = (e: KeyboardEvent) => {
    const i = els.indexOf(e.target as HTMLElement);
    if (i < 0) return;
    const s = rowState(rows, i);
    const r = rows[i];
    const step = (from: number, by: number): number => {
      for (let j = from + by; j >= 0 && j < els.length; j += by) if (els[j]) return j;
      return -1;
    };
    const go = (j: number): void => { if (j >= 0) els[j]?.focus(); };
    switch (e.key) {
      case "ArrowDown": go(step(i, 1)); break;
      case "ArrowUp": go(step(i, -1)); break;
      case "Home": go(step(-1, 1)); break;
      case "End": go(step(els.length, -1)); break;
      case "ArrowRight":
        if (s.foldable && !s.open) o.onFold(r.key);
        else if (s.foldable) go(step(i, 1));
        break;
      case "ArrowLeft":
        if (s.foldable && s.open) o.onFold(r.key);
        else go(parentOf(rows, i));
        break;
      case "Enter":
      case " ":
        if (s.pickable) o.onSelect(r.key);
        else if (s.foldable) o.onFold(r.key);
        break;
      default: return;
    }
    e.preventDefault();
  };
  focusRow(host, keep);
}
