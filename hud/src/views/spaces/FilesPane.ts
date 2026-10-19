// FilesPane.ts — Files and the map merged (spaces-redesign D9): one tree, the live listing joined with the map, each
// file's description inline; NEW / CHANGED badges (D19: NEW info, CHANGED warn), "Not described yet", "not mapped"
// with no badge for a file the map skips; filter by path or description; All · New · Changed; Describe N new (only
// mappable files count; the scan's budgets apply, D33); ↻ per file, off under provider `none` with the reason.
import type { WorkspaceEntry } from "../../data/snapshot";
import { shortAge } from "../../data/hostSessions";
import {
  FILE_BADGE_LABEL, FILE_FILTERS, FILE_FILTER_LABEL, describeDisabledReason, describeNewCount, filterCounts, mapSummary,
  mergeDir, rowVisible, treeMatches, type TreeRow,
} from "../../data/workspaceMaps";
import { button, mappable, segmented, whyLine, HIDDEN_MAP_TEXT, type SpacesCtx } from "./ui";

/** The folders the tree shows open: the ones the user opened, and under a filter every folder holding a match. */
export function openFolders(ctx: Pick<SpacesCtx, "ui" | "index">): Set<string> {
  const m = treeMatches(ctx.index, { filter: ctx.ui.files.filter, query: ctx.ui.files.query });
  return new Set([...ctx.ui.files.open, ...(m.active ? m.dirs : [])]);
}

/** Every mappable file the loaded listings show that the map does not know yet (Describe N new counts them). */
function unscanned(ctx: SpacesCtx): string[] {
  const out: string[] = [];
  for (const [dir, entries] of ctx.listings) {
    if (!entries) continue;
    for (const r of mergeDir(dir, entries, ctx.index)) if (r.unscanned) out.push(r.rel);
  }
  return out;
}

export function renderFiles(host: HTMLElement, ctx: SpacesCtx, e: WorkspaceEntry): void {
  const tools = host.createDiv({ cls: "aos-spc-filetools" });
  const search = tools.createEl("label", { cls: "aos-spc-search aos-spc-filesearch" });
  const searchIco = search.createSpan({ cls: "aos-spc-ico aos-spc-searchico" });
  ctx.setIcon(searchIco, "search");
  const input = search.createEl("input", {
    cls: "aos-spc-q",
    attr: { type: "search", "aria-label": "Filter files", placeholder: "Filter by path or description…", "data-spc-key": "files-q", spellcheck: "false" },
  });
  input.value = ctx.ui.files.query;
  input.addEventListener("input", () => { ctx.ui.files.query = input.value; ctx.act.tree(); });

  const counts = filterCounts(ctx.index);
  segmented(tools, "Show", FILE_FILTERS.map((f) => ({ id: f, text: FILE_FILTER_LABEL[f], count: f === "all" ? null : counts[f] })), ctx.ui.files.filter, "ffilter", (f) => {
    ctx.ui.files.filter = f;
    ctx.act.tree();
  });

  const canMap = mappable(e);
  const n = describeNewCount(ctx.index, unscanned(ctx));
  const heuristic = ctx.provider === "none";
  // The inverse fill only when there is something to describe; with nothing new it is a quiet, off button that says so.
  const canDescribe = canMap && n > 0;
  const describe = button(tools, `aos-spc-btn${canDescribe ? " aos-spc-primary" : ""} aos-spc-describe`, n ? `Describe ${n} new` : "Nothing new", {
    key: "describe",
    disabled: !canDescribe,
    title: !canMap ? HIDDEN_MAP_TEXT
      : n === 0 ? "Nothing new to describe"
      : `Describes the new files within the scan's budgets${heuristic ? ", with the heuristic: no model provider is set up" : "; under a paid host the heuristic, unless scan.fileMapBudgetUnder* is raised"}`,
  });
  describe.addEventListener("click", () => ctx.act.mapNow());

  const sum = mapSummary(ctx.map);
  const line = host.createDiv({ cls: "aos-spc-mapline" });
  // Describe, Map now and ↻ are off for a hidden folder: say why in words (a disabled button's title is not read).
  if (!canMap) whyLine(host, HIDDEN_MAP_TEXT, { div: true });
  if (!ctx.map) {
    line.appendText("No map yet: run a scan, or map this workspace now. ");
    const now = button(line, "aos-spc-linkbtn", "Map now", { key: "mapnow", disabled: !canMap, title: canMap ? "Describe this workspace's files" : HIDDEN_MAP_TEXT });
    now.addEventListener("click", () => ctx.act.mapNow());
  } else {
    const age = sum.lastDescribedAt ? shortAge(sum.lastDescribedAt, ctx.now) : "";
    line.setText([
      `${sum.described} of ${sum.total} described`,
      age ? `last described ${age === "now" ? "just now" : `${age} ago`}` : "",
      sum.heuristic ? `${sum.heuristic} by the heuristic` : "",
    ].filter(Boolean).join(" · "));
  }

  // role=tree only holds treeitems (ARIA's required owned elements): a loading or empty line is drawn in its place.
  const tree = host.createDiv({ cls: "aos-spc-tree", attr: { "data-spc-scroll": "tree" } });
  const rootEntries = ctx.listings.get("");
  if (rootEntries === undefined) { tree.createDiv({ cls: "aos-spc-empty", text: "Reading the folder…" }); return; }
  if (rootEntries === null) { tree.createDiv({ cls: "aos-spc-empty", text: "This folder cannot be read." }); return; }
  if (!rootEntries.length) { tree.createDiv({ cls: "aos-spc-empty", text: "This folder is empty." }); return; }
  const filter = { filter: ctx.ui.files.filter, query: ctx.ui.files.query };
  const matches = treeMatches(ctx.index, filter);
  const open = openFolders(ctx);
  const describeOff = !canMap ? HIDDEN_MAP_TEXT : describeDisabledReason(ctx.provider);
  let shown = 0;
  const walk = (dir: string, depth: number) => {
    const entries = ctx.listings.get(dir);
    if (!entries) return;
    for (const r of mergeDir(dir, entries, ctx.index)) {
      if (!rowVisible(r, filter, matches)) continue;
      shown++;
      treeRow(tree, ctx, r, depth, open.has(r.rel), describeOff);
      if (r.isDir && open.has(r.rel)) {
        if (ctx.listings.get(r.rel) === null) {
          tree.createDiv({
            cls: "aos-spc-tnote", text: "Cannot read this folder",
            attr: { role: "treeitem", "aria-level": String(depth + 2), "aria-disabled": "true", style: `padding-left:${36 + (depth + 1) * 18}px` },
          });
        }
        walk(r.rel, depth + 1);
      }
    }
  };
  walk("", 0);
  if (!shown) { tree.createDiv({ cls: "aos-spc-empty", text: matches.active ? "No file matches." : "This folder is empty." }); return; }
  tree.setAttribute("role", "tree");
  tree.setAttribute("aria-label", "Files");
  // One tab stop: the previewed file, else the first row (a roving tabindex).
  const rows = Array.from(tree.querySelectorAll<HTMLElement>(".aos-spc-trow"));
  (rows.find((x) => x.classList.contains("is-selected")) ?? rows[0])?.setAttribute("tabindex", "0");
  treeKeys(tree, ctx);
}

function treeRow(tree: HTMLElement, ctx: SpacesCtx, r: TreeRow, depth: number, isOpen: boolean, describeOff: string | null): void {
  const sel = !r.isDir && ctx.ui.files.preview === r.rel;
  const attr: Record<string, string> = {
    role: "treeitem", "aria-level": String(depth + 1), tabindex: "-1", "data-spc-key": `file:${r.rel}`, "data-rel": r.rel,
  };
  if (r.isDir) attr["aria-expanded"] = String(isOpen);
  else attr["aria-selected"] = String(sel);
  const row = tree.createDiv({ cls: `aos-spc-trow ${r.isDir ? "is-dir" : "is-file"}${sel ? " is-selected" : ""}`, attr });
  const name = row.createSpan({ cls: "aos-spc-tname" });
  name.style.paddingLeft = `${depth * 18}px`;
  const caret = name.createSpan({ cls: "aos-spc-tcaret" });
  if (r.isDir) ctx.setIcon(caret, isOpen ? "chevron-down" : "chevron-right");
  const kindIco = name.createSpan({ cls: "aos-spc-ticon" });
  ctx.setIcon(kindIco, r.isDir ? "folder" : "file");
  name.createSpan({ cls: "aos-spc-tlabel", text: r.name, attr: { title: r.rel } });
  row.createSpan({
    cls: `aos-spc-tdesc${!r.mapped ? " is-unmapped" : r.undescribed ? " is-undescribed" : ""}`,
    text: r.descText, attr: r.skipText ? { title: r.skipText } : r.desc ? { title: r.desc } : {},
  });
  if (r.badge) row.createSpan({ cls: `aos-spc-badge is-${r.badge}`, text: FILE_BADGE_LABEL[r.badge], attr: r.unscanned ? { title: "Not in the map yet: the next scan describes it" } : {} });
  else row.createSpan({ cls: "aos-spc-nobadge" });
  const end = row.createSpan({ cls: "aos-spc-tend" });
  if (r.isDir) { if (r.rollup?.files) end.setText(String(r.rollup.files)); }
  else if (r.mapped && !r.unscanned) {
    const re = button(end, "aos-spc-iconbtn aos-spc-redesc", null, {
      label: `Describe ${r.rel} again`, title: describeOff ?? `Describe ${r.rel} again`, disabled: !!describeOff, attr: { tabindex: "-1" },
    });
    ctx.setIcon(re, "refresh-cw");
    re.addEventListener("click", (ev) => { ev.stopPropagation(); ctx.act.describeFile(r.rel); });
  }
  row.addEventListener("click", () => activate(ctx, r));
}

function activate(ctx: SpacesCtx, r: Pick<TreeRow, "rel" | "isDir">): void {
  if (r.isDir) {
    if (ctx.ui.files.open.has(r.rel)) ctx.ui.files.open.delete(r.rel);
    else ctx.ui.files.open.add(r.rel);
    ctx.act.tree();
    return;
  }
  ctx.ui.files.preview = r.rel;
  ctx.act.redraw(["centre", "right"]);
}

/** The tree's keys: arrows move, Right opens a folder, Left closes it, Enter and Space open a folder or preview a file. */
function treeKeys(tree: HTMLElement, ctx: SpacesCtx): void {
  tree.addEventListener("keydown", (ev) => {
    const rows = Array.from(tree.querySelectorAll<HTMLElement>(".aos-spc-trow"));
    const cur = (ev.target as HTMLElement).closest<HTMLElement>(".aos-spc-trow");
    const i = cur ? rows.indexOf(cur) : -1;
    if (i < 0) return;
    const rel = cur!.getAttribute("data-rel") ?? "";
    const isDir = cur!.classList.contains("is-dir");
    const isOpen = cur!.getAttribute("aria-expanded") === "true";
    const move = (j: number) => { ev.preventDefault(); rows[i].setAttribute("tabindex", "-1"); rows[j].setAttribute("tabindex", "0"); rows[j].focus(); };
    if (ev.key === "ArrowDown") { if (i < rows.length - 1) move(i + 1); else ev.preventDefault(); }
    else if (ev.key === "ArrowUp") { if (i > 0) move(i - 1); else ev.preventDefault(); }
    else if (ev.key === "Home") move(0);
    else if (ev.key === "End") move(rows.length - 1);
    else if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); activate(ctx, { rel, isDir }); }
    else if (ev.key === "ArrowRight" && isDir && !isOpen) { ev.preventDefault(); activate(ctx, { rel, isDir }); }
    else if (ev.key === "ArrowLeft" && isDir && isOpen) { ev.preventDefault(); activate(ctx, { rel, isDir }); }
  });
}
