import { App, Notice, TFile } from "obsidian";
import type AgenticOSPlugin from "../../main";
import { loadInventory, InventoryData, InventoryAgent, InventorySkill } from "../data/inventory";
import { loadSnapshot, Snapshot, SnapshotCapabilities, FolderAtlasEntry } from "../data/snapshot";
import { loadRunsForMonth, AgentRun, formatRelative } from "../data/runs";
import { buildMonthlyBudget, formatUSD, BudgetConfig } from "../data/cost";
import { sparklineElement, deltaArrow } from "../data/sparkline";
import { donutElement, DONUT_COLORS } from "../data/donut";
import { readVaultConfig } from "../data/aosConfig";

// Sections: INVENTORY (counts + full lists: agents, skills, commands, hooks — ported from
// InventoryView's list renderers against src/data/inventory.ts loaders, extended with two
// new tabs — see renderCommandRows/renderHookRows below for why those two aren't literal
// ports), DISK (Mission Control's renderDisk panel — total + donut + legend), COST DETAIL
// (Mission Control's renderCost panel in full). This is a free function, not a class — every
// call re-fetches fresh data and builds fresh DOM into `host`; no Components, timers, or
// event subscriptions are created, so there is nothing for the drawer to leak when
// WorkbenchView.closeDrawer() empties the host without calling back in here (see Task 6
// brief's cleanup note — this sidesteps it by never allocating anything that needs it).
export async function renderSystemDrawer(plugin: AgenticOSPlugin, host: HTMLElement): Promise<void> {
  host.addClass("aos-sysdrawer");
  const app = plugin.app;

  const [inv, snapshot, monthRuns, budgetConfig, budgetLedger] = await Promise.all([
    loadInventory(app),
    loadSnapshot(app),
    loadRunsForMonth(app),
    loadSystemBudgetConfig(app),
    loadBudgetLedger(app),
  ]);

  renderInventorySection(host, app, inv, snapshot);
  renderDiskSection(host, snapshot);
  const { enabled: costOn, monthlyBudget } = readVaultConfig(plugin.vaultRoot(), plugin.claudeConfigDir()).cost;
  if (costOn === true && typeof monthlyBudget === "number") {
    renderCostDetailSection(host, monthRuns, budgetConfig, budgetLedger, monthlyBudget);
  }
}

// ── INVENTORY ────────────────────────────────────────────────────────────

type InvTab = "agents" | "skills" | "commands" | "hooks";

function renderInventorySection(
  panelHost: HTMLElement,
  app: App,
  inv: InventoryData | null,
  snapshot: Snapshot | null,
): void {
  const panel = makeSectionPanel(panelHost, "INVENTORY");
  const body = panel.createDiv({ cls: "aos-panel-body" });
  const caps = snapshot?.capabilities;

  // PORT of InventoryView's counts strip (~68-74) — same aos-pill/makeChip shape, extended
  // with commands/hooks counts (InventoryView's strip only ever covered agents/skills).
  const strip = body.createDiv({ cls: "aos-inv-strip" });
  makeChip(strip, `${inv?.counts.agents ?? 0} agents`, "aos-text-cyan");
  makeChip(strip, `${inv?.counts.skills ?? 0} skills`, "aos-text-amber");
  makeChip(strip, `${caps?.commands.count ?? 0} commands`, "aos-dim");
  makeChip(strip, `${caps?.hooks.count ?? 0} hooks`, "aos-dim");
  if (caps?.codex) makeChip(strip, `codex: ${caps.codex.skills} skills · ${caps.codex.prompts} prompts · ${caps.codex.hooks} hooks`, "aos-dim");

  const tabsRow = body.createDiv({ cls: "aos-inv-tabs" });
  const searchRow = body.createDiv({ cls: "aos-inv-search" });
  const input = searchRow.createEl("input", { cls: "aos-inv-input", type: "text", placeholder: "filter…" });
  const listHost = body.createDiv({ cls: "aos-inv-table" });

  let tab: InvTab = "agents";
  let filter = "";

  const tabDefs: Array<{ key: InvTab; label: string; count: number }> = [
    { key: "agents", label: "agents", count: inv?.counts.agents ?? 0 },
    { key: "skills", label: "skills", count: inv?.counts.skills ?? 0 },
    { key: "commands", label: "commands", count: caps?.commands.count ?? 0 },
    { key: "hooks", label: "hooks", count: caps?.hooks.count ?? 0 },
  ];

  // PORT of InventoryView's tab-switcher (~53-59) — same aos-inv-tab(-active) classes and
  // click-to-switch behavior. Adaptation: InventoryView keeps `this.tab` as an instance field;
  // this is a plain function, so `tab`/`filter` are closure locals instead — they live only as
  // long as these button/input DOM nodes do, and die with them when the drawer next closes or
  // reopens (openDrawer()/closeDrawer() both empty the host), which is what "stateless
  // rendering" means here per the brief's cleanup note.
  const paintTabs = (): void => {
    tabsRow.empty();
    for (const t of tabDefs) {
      const btn = tabsRow.createEl("button", {
        cls: `aos-inv-tab${tab === t.key ? " aos-inv-tab-active" : ""}`,
        text: `${t.label} (${t.count})`,
      });
      btn.addEventListener("click", () => { tab = t.key; paintTabs(); paintList(); });
    }
  };

  const paintList = (): void => {
    listHost.empty();
    const f = filter.toLowerCase();
    if (tab === "agents") renderAgentRows(listHost, app, inv?.agents ?? [], f);
    else if (tab === "skills") renderSkillRows(listHost, app, inv?.skills ?? [], f);
    else if (tab === "commands") renderCommandRows(listHost, app, caps?.commands.names ?? [], f);
    else renderHookRows(listHost, caps?.hooks, f);
  };

  input.addEventListener("input", () => { filter = input.value; paintList(); });

  paintTabs();
  paintList();
}

// PORT of InventoryView.renderAgents (~93-105) — identical row shape/classes and
// click-to-open-file behavior.
function renderAgentRows(parent: HTMLElement, app: App, agents: InventoryAgent[], filter: string): void {
  const rows = agents.filter((a) => !filter || a.name.toLowerCase().includes(filter));
  if (rows.length === 0) { parent.createDiv({ cls: "aos-dim", text: "no matches" }); return; }
  for (const a of rows) {
    const row = parent.createDiv({ cls: "aos-inv-row aos-inv-row-clickable" });
    row.createSpan({ cls: "aos-inv-name", text: a.name });
    if (a.gsd) row.createSpan({ cls: "aos-pill aos-pill-dim", text: "gsd" });
    if (a.bytes) row.createSpan({ cls: "aos-dim", text: humanSize(a.bytes) });
    row.addEventListener("click", () => { void openInventoryFile(app, a.path || `agents/${a.name}.md`); });
  }
}

// PORT of InventoryView.renderSkills (~107-119) — identical row shape/classes and
// click-to-open-file behavior.
function renderSkillRows(parent: HTMLElement, app: App, skills: InventorySkill[], filter: string): void {
  const rows = skills.filter((s) => !filter || s.name.toLowerCase().includes(filter));
  if (rows.length === 0) { parent.createDiv({ cls: "aos-dim", text: "no matches" }); return; }
  for (const s of rows) {
    const row = parent.createDiv({ cls: "aos-inv-row aos-inv-row-clickable" });
    row.createSpan({ cls: "aos-inv-name", text: s.name });
    if (s.gsd) row.createSpan({ cls: "aos-pill aos-pill-dim", text: "gsd" });
    if (s.missingSkillMd) row.createSpan({ cls: "aos-pill aos-pill-rose", text: "missing" });
    row.addEventListener("click", () => {
      void openInventoryFile(app, s.path ? `${s.path}/SKILL.md` : `skills/${s.name}/SKILL.md`);
    });
  }
}

// NEW, not a port — no view in this codebase renders native slash-commands as a list;
// Mission Control's Telemetry panel only ever showed `capabilities.commands.count` (a
// number), never `.names`. Row shape/click-to-open reuse InventoryView's exact pattern
// applied to the one existing data source for these names (snapshot.capabilities.commands).
function renderCommandRows(parent: HTMLElement, app: App, names: string[], filter: string): void {
  const rows = names.filter((n) => !filter || n.toLowerCase().includes(filter)).sort((a, b) => a.localeCompare(b));
  if (rows.length === 0) { parent.createDiv({ cls: "aos-dim", text: "no matches" }); return; }
  for (const name of rows) {
    const row = parent.createDiv({ cls: "aos-inv-row aos-inv-row-clickable" });
    row.createSpan({ cls: "aos-inv-name", text: `/${name}` });
    row.addEventListener("click", () => { void openInventoryFile(app, `commands/${name}.md`); });
  }
}

// NEW, not a port — hooks have no per-item file target (snapshot only carries script
// filenames, not vault paths), so this is stat rows (count/wired, same shape as Mission
// Control's makeStat-based panels) plus the two named-issue lists Mission Control's
// Telemetry line only ever showed as counts (orphans/missingRefs) — same amber/rose
// convention MC uses for them (renderTelemetry ~415-427).
function renderHookRows(
  parent: HTMLElement,
  hooks: SnapshotCapabilities["hooks"] | undefined,
  filter: string,
): void {
  if (!hooks) { parent.createDiv({ cls: "aos-dim", text: "no data" }); return; }
  makeStat(parent, "count", String(hooks.count ?? "—"));
  makeStat(parent, "wired", `${hooks.wired ?? "—"}/${hooks.count ?? "—"}`);

  const f = filter.toLowerCase();
  const orphans = (hooks.orphans ?? []).filter((n) => !f || n.toLowerCase().includes(f));
  const missing = (hooks.missingRefs ?? []).filter((n) => !f || n.toLowerCase().includes(f));
  if (orphans.length === 0 && missing.length === 0) {
    parent.createDiv({ cls: "aos-dim", text: filter ? "no matches" : "no orphan or missing-ref hooks" });
    return;
  }
  for (const n of orphans) {
    const row = parent.createDiv({ cls: "aos-inv-row" });
    row.createSpan({ cls: "aos-inv-name", text: n });
    row.createSpan({ cls: "aos-pill aos-pill-amber", text: "orphan" });
  }
  for (const n of missing) {
    const row = parent.createDiv({ cls: "aos-inv-row" });
    row.createSpan({ cls: "aos-inv-name", text: n });
    row.createSpan({ cls: "aos-pill aos-pill-rose", text: "missing ref" });
  }
}

// PORT of InventoryView.openAgentFile/openSkillFolder (~152-166) — unified into one helper
// since both did the identical vault-relative-resolve + open-or-Notice sequence.
async function openInventoryFile(app: App, p: string): Promise<void> {
  const rel = vaultRelative(app, p);
  const file = app.vault.getAbstractFileByPath(rel);
  if (file instanceof TFile) await app.workspace.getLeaf("tab").openFile(file);
  else new Notice(`Not found: ${rel}`);
}

// Mirrors InventoryView's module-private vaultRelative (~169-173) — not exported, so
// duplicated here rather than reaching into a view that retires in Task 9.
function vaultRelative(app: App, p: string): string {
  const base = (app.vault.adapter as unknown as { getBasePath?: () => string }).getBasePath?.();
  if (base && p.startsWith(base + "/")) return p.slice(base.length + 1);
  return p.replace(/^\//, "");
}

// ── DISK ─────────────────────────────────────────────────────────────────

// PORT of the old Mission Control view's renderDisk (~715-747) — same top-6-plus-"other" bucketing math
// and donut+legend markup, reusing donut.ts — donutElement() now, same arc geometry as Mission Control's donutSvg; the
// chart helper itself is not touched or rewritten.
function renderDiskSection(panelHost: HTMLElement, snapshot: Snapshot | null): void {
  const panel = makeSectionPanel(panelHost, "DISK  ── vault footprint");
  const body = panel.createDiv({ cls: "aos-panel-body" });
  const atlas = snapshot?.folderAtlas || [];
  if (atlas.length === 0) {
    body.createSpan({ cls: "aos-dim", text: "no folder atlas" });
    return;
  }
  const total = atlas.reduce((a, f) => a + (f.bytes || 0), 0);
  body.createDiv({ cls: "aos-disk-total", text: humanSize(total) });

  const BIG = 6;
  const present = atlas.filter((f) => f.present && f.bytes).sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
  const top = present.slice(0, BIG);
  const restBytes = present.slice(BIG).reduce((a, f) => a + (f.bytes || 0), 0);
  // `toSeg`, not `seg`: the legend loop below already binds `seg` as its forEach parameter.
  const toSeg = (f: FolderAtlasEntry) => ({ name: f.name, bytes: f.bytes || 0, scope: f.scope, approx: f.approx === true });
  const segs = restBytes > 0
    ? [...top.map(toSeg), { name: "other", bytes: restBytes, scope: undefined, approx: false }]
    : top.map(toSeg);

  const chart = body.createDiv({ cls: "aos-disk-chart" });
  chart.appendChild(donutElement(segs, total, 140));

  const legend = body.createDiv({ cls: "aos-disk-legend" });
  segs.forEach((seg, i) => {
    const row = legend.createDiv({ cls: "aos-disk-legend-row" });
    const color = DONUT_COLORS[i % DONUT_COLORS.length];
    const swatch = row.createSpan({ cls: "aos-disk-swatch" });
    swatch.setAttribute("style", `background:${color}`);
    row.createSpan({ cls: "aos-disk-name", text: seg.name });
    if (seg.scope) row.createSpan({ cls: "aos-disk-scope aos-dim", text: seg.scope, attr: { title: seg.scope === "config" ? "under the Claude config dir" : "under the vault" } });
    row.createSpan({ cls: "aos-disk-bytes aos-dim", text: `${seg.approx ? "~" : ""}${humanSize(seg.bytes)}`, attr: seg.approx ? { title: "stat-walked two levels deep; deeper files are not counted" } : undefined });
  });
}

// ── COST DETAIL ──────────────────────────────────────────────────────────

// PORT of the old Mission Control view's renderCost (~1068-1148) — the full body (tiles, budget
// bar+marker+tone, daily sparkline, top-scripts, anchored/stale/no-anchor footnote), not just
// the "tiles + daily chart + top-scripts" the task brief's stub comment calls out by name:
// the budget-state bar and footnote are inseparable parts of the same panel, and dropping
// them would silently lose the "are we over/on-pace/near budget" signal, which is the most
// actionable part of the panel. Reuses buildMonthlyBudget/formatUSD (cost.ts) and
// sparklineElement/deltaArrow (sparkline.ts) — same geometry as Mission Control's sparklineSvg —
// neither is rewritten.
function renderCostDetailSection(
  panelHost: HTMLElement,
  monthRuns: AgentRun[],
  budgetConfig: Partial<BudgetConfig> | undefined,
  budgetLedger: { readings: number; settled: number; lastDerived: number | null },
  monthlyBudget: number,
): void {
  const b = buildMonthlyBudget(monthRuns, budgetConfig, new Date(), monthlyBudget);
  const monthShort = b.monthLabel.split(" ")[0].toLowerCase();
  const panel = makeSectionPanel(panelHost, `COST DETAIL  ── ${monthShort} · /$${b.budget}`);
  const body = panel.createDiv({ cls: "aos-panel-body" });
  if (monthRuns.length === 0 && !b.anchored) {
    body.createSpan({ cls: "aos-dim", text: "no runs this month" });
    return;
  }

  const tiles = body.createDiv({ cls: "aos-tiles" });
  makeTile(tiles, formatUSD(b.monthToDate), "this month");
  makeTile(tiles, formatUSD(b.budget), "budget");
  makeTile(tiles, formatUSD(b.budgetRemaining), "remaining");
  makeTile(tiles, formatUSD(b.paceProjected), "projected");

  const isOver = b.monthToDate > b.budget;
  const overPace = b.paceProjected > b.budget;
  const tone = (isOver || overPace || b.pctOfBudget >= 0.9) ? "rose" : b.pctOfBudget >= 0.7 ? "amber" : "green";
  const stateText = isOver ? "over budget"
    : overPace ? "on pace to overspend"
    : b.pctOfBudget >= 0.9 ? "near budget"
    : b.pctOfBudget >= 0.7 ? "watch pace"
    : "on track";

  const wrap = body.createDiv({ cls: "aos-budget" });
  const meta = wrap.createDiv({ cls: "aos-budget-meta" });
  meta.createSpan({ cls: "aos-budget-pct", text: `${(b.pctOfBudget * 100).toFixed(1)}% used` });
  meta.createSpan({ cls: `aos-budget-state aos-text-${tone}`, text: stateText });
  const bar = wrap.createDiv({ cls: "aos-budget-bar" });
  const fill = bar.createDiv({ cls: `aos-budget-fill aos-bg-${tone}` });
  fill.style.width = `${Math.min(100, b.pctOfBudget * 100).toFixed(1)}%`;
  const paceFrac = b.budget > 0 ? Math.min(1, Math.max(0, b.paceProjected / b.budget)) : 0;
  const marker = bar.createDiv({ cls: "aos-budget-marker" });
  marker.style.left = `${(paceFrac * 100).toFixed(1)}%`;
  marker.title = `projected month-end: ${formatUSD(b.paceProjected)} (day ${b.dayOfMonth}/${b.daysInMonth})`;

  const series = b.daily.map((d) => d.cost);
  const spark = body.createDiv({ cls: "aos-trends" });
  const row = spark.createDiv({ cls: "aos-trend" });
  row.createSpan({ cls: "aos-trend-label", text: `${monthShort} daily` });
  const sparkWrap = row.createSpan({ cls: "aos-trend-spark" });
  sparkWrap.appendChild(sparklineElement(series, { width: 120, height: 20 }));
  row.createSpan({ cls: "aos-trend-delta", text: deltaArrow(series.map((c) => Math.round(c * 100))) });

  if (b.topScripts.length > 0) {
    const top = body.createDiv({ cls: "aos-cost-top" });
    top.createDiv({ cls: "aos-cost-top-head aos-dim", text: `top scripts (${monthShort})` });
    for (const s of b.topScripts.slice(0, 4)) {
      const r = top.createDiv({ cls: "aos-cost-row" });
      r.createSpan({ cls: "aos-cost-script", text: s.script });
      r.createSpan({ cls: "aos-cost-count aos-dim", text: `×${s.count}` });
      r.createSpan({ cls: "aos-cost-amount aos-text-amber", text: formatUSD(s.cost) });
    }
  }

  if (b.anchored && !b.stale) {
    const anchorDate = budgetConfig?.anchorAt ? formatRelative(budgetConfig.anchorAt) : "";
    const calSrc = budgetLedger.settled > 0
      ? `cal ×${b.calibration} (pooled, ${budgetLedger.settled}/${budgetLedger.readings})`
      : `cal ×${b.calibration} (seed)`;
    body.createDiv({
      cls: "aos-dim aos-budget-note",
      text: `${formatUSD(b.anchorUsd)} actual (anchored ${anchorDate}) + ${formatUSD(b.newSpend)} new · ${calSrc}`,
    });
  } else if (b.stale) {
    body.createDiv({
      cls: "aos-text-amber aos-budget-note",
      text: `⚠ anchor is from ${budgetConfig?.month} — re-anchor for ${monthShort}: cost-budget.js --anchor <usd>`,
    });
  } else {
    body.createDiv({
      cls: "aos-dim aos-budget-note",
      text: `estimate ×${b.calibration} · ${b.costedCount}/${b.runCount} sessions costed (no anchor set)`,
    });
  }
}

// Mirrors PulseTab's private loadBudgetConfig(), itself mirroring the old Mission Control
// view's private loadBudgetConfig (~1047-1054) — cost.ts exports no loader for the anchor file.
// renderSystemDrawer is a free function, not a PulseTab method, so it cannot call PulseTab's
// private instance method directly; this is a third, disclosed mirror of the same lines.
async function loadSystemBudgetConfig(app: App): Promise<Partial<BudgetConfig> | undefined> {
  try {
    const raw = await app.vault.adapter.read("brain/_index/cost-budget.json");
    return JSON.parse(raw) as Partial<BudgetConfig>;
  } catch {
    return undefined;
  }
}

// Mirrors the old Mission Control view's private loadBudgetLedger (~1056-1066). Not named in the task
// brief's "Consumes" list, but renderCost()'s anchored-footnote text (pooled-calibration vs.
// seed) reads straight from it — porting "Mission Control's cost panel" without this would
// silently change that footnote's wording.
async function loadBudgetLedger(app: App): Promise<{ readings: number; settled: number; lastDerived: number | null }> {
  try {
    const raw = await app.vault.adapter.read("brain/_index/cost-budget-ledger.jsonl");
    const rows = raw.trim().split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean) as Array<{ tgRawDelta?: number; derivedCalibration?: number | null }>;
    const settledRows = rows.filter((r) => typeof r.tgRawDelta === "number" && r.tgRawDelta > 0);
    const lastSettled = settledRows.length ? settledRows[settledRows.length - 1] : null;
    return { readings: rows.length, settled: settledRows.length, lastDerived: lastSettled?.derivedCalibration ?? null };
  } catch {
    return { readings: 0, settled: 0, lastDerived: null };
  }
}

// ── shared helpers ───────────────────────────────────────────────────────

// Mirrors the old Mission Control view's private makePanel (~1005-1015) — same DOM shape/classes, so
// the ported sections get identical panel chrome without importing a private method from a
// view that was retired in Task 9.
function makeSectionPanel(host: HTMLElement, title: string, badge?: string): HTMLElement {
  const panel = host.createDiv({ cls: "aos-panel" });
  const head = panel.createDiv({ cls: "aos-panel-head" });
  head.createSpan({ cls: "aos-panel-title", text: title });
  head.createSpan({ cls: "aos-panel-rule" });
  if (badge) head.createSpan({ cls: "aos-panel-badge", text: badge });
  return panel;
}

// Mirrors the old Mission Control view's private makeStat (~1017-1022).
function makeStat(parent: HTMLElement, label: string, value: string): void {
  const row = parent.createDiv({ cls: "aos-stat-row" });
  row.createSpan({ cls: "aos-stat-label", text: label });
  row.createSpan({ cls: "aos-stat-dots" });
  row.createSpan({ cls: "aos-stat-value", text: value });
}

// Mirrors the old Mission Control view's private makeTile (~1024-1028).
function makeTile(parent: HTMLElement, value: number | string, label: string): void {
  const tile = parent.createDiv({ cls: "aos-tile" });
  tile.createDiv({ cls: "aos-tile-value", text: String(value) });
  tile.createDiv({ cls: "aos-tile-label", text: label });
}

// Mirrors InventoryView's private makeChip (~148-150).
function makeChip(parent: HTMLElement, text: string, cls: string): void {
  parent.createSpan({ cls: `aos-pill aos-pill-dim ${cls}`, text });
}

// Mirrors the old Mission Control view's module-level humanSize (~19-25) / InventoryView's
// module-level formatBytes (~175-180) — both views define an equivalent, neither exports it.
function humanSize(bytes: number | undefined): string {
  if (!bytes || !Number.isFinite(bytes)) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
