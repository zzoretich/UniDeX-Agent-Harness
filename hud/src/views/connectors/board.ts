// board.ts — the Connectors tab's health board (spec 2026-10-23-connectors-tab D3, D23): the header, the four summary
// tiles, NEEDS ATTENTION with one fix each, the CONNECTORS and MCP SERVERS grids, and the folded BUILT IN, OFF and
// PROJECT rows. It only draws: every action is a callback ConnectorsTab owns. Elements that can hold the focus carry a
// `data-fk` key so a redraw puts it back (ConnectorsTab.render).
import { setIcon } from "obsidian";
import {
  CONN_HOSTS, CONN_HOST_LABEL, CONN_TILES, TILE_LABEL, STATUS_LABEL, alertKind, attentionFix, filterCards, groupPeek, inTile, metaLine,
  serverSub, sparkHeights, statusTone, tileSub, useLine,
  type ConnBoard, type ConnCard, type ConnGroup, type ConnHost, type ConnTile,
} from "../../data/connectorsModel";

export interface BoardCtx {
  board: ConnBoard;
  /** The enabled hosts (sessionHosts): only theirs get dots and counts. */
  hosts: readonly ConnHost[];
  now: number;
  everyMin: number;
  checking: boolean;
  /** Why the last automatic check failed, until one succeeds. */
  failed: string | null;
  query: string;
  tile: ConnTile | null;
  /** The folded groups shown open. */
  folds: ReadonlySet<string>;
  on: {
    check(): void;
    tile(t: ConnTile): void;
    query(q: string): void;
    open(card: ConnCard): void;
    fold(group: FoldGroup): void;
    fix(card: ConnCard): void;
    upgrade(): void;
  };
}

export type FoldGroup = "builtin" | "off" | "project";
const FOLDS: { group: FoldGroup; label: string }[] = [
  { group: "builtin", label: "BUILT IN · SEEN IN USE" },
  { group: "off", label: "OFF" },
  { group: "project", label: "PROJECT" },
];

const SPARK_PX = 24;

/** The header: title, the mono meta line, the filter and Check now. */
export function drawHead(parent: HTMLElement, c: BoardCtx): void {
  const head = parent.createDiv({ cls: "aos-con-head" });
  const titles = head.createDiv({ cls: "aos-con-titles" });
  titles.createEl("h1", { cls: "aos-con-h1", text: "Connectors" });
  const meta = metaLine(c.board, c.now, c.everyMin, { checking: c.checking, failed: c.failed });
  titles.createEl("p", { cls: `aos-con-meta${c.failed && !c.checking ? " is-danger" : ""}`, text: meta, attr: { "aria-live": "polite" } });
  const tools = head.createDiv({ cls: "aos-con-headtools" });
  const search = tools.createDiv({ cls: "aos-con-search" });
  const glass = search.createSpan({ cls: "aos-con-ico aos-con-searchico" });
  setIcon(glass, "search");
  const q = search.createEl("input", {
    cls: "aos-con-q", attr: { type: "search", placeholder: "Filter by name, program or tool…", "aria-label": "Filter connectors", "data-fk": "q" },
  });
  q.value = c.query;
  q.addEventListener("input", () => c.on.query(q.value));
  const can = c.board.listed && c.hosts.length > 0;
  const check = tools.createEl("button", {
    cls: "aos-con-btn aos-con-check",
    attr: { type: "button", "data-tour": "connectors-check", "data-fk": "check", title: "aos mcp check: ask each host which servers work and list their tools" },
  });
  const spin = check.createSpan({ cls: "aos-con-ico" });
  setIcon(spin, "refresh-cw");
  check.createSpan({ text: c.checking ? "Checking…" : "Check now" });
  check.disabled = c.checking || !can;
  check.addEventListener("click", () => c.on.check());
}

/** Everything under the header. */
export function drawBody(body: HTMLElement, c: BoardCtx): void {
  const b = c.board;
  if (!b.listed) {
    const box = body.createDiv({ cls: "aos-con-empty aos-con-upgrade" });
    box.createEl("p", { text: "This vault's runtime predates Connectors: run aos upgrade to list every MCP server and connector both hosts can use here." });
    const up = box.createEl("button", { cls: "aos-con-btn", text: "❯_ aos upgrade", attr: { type: "button", "data-fk": "upgrade" } });
    up.addEventListener("click", () => c.on.upgrade());
    return;
  }
  if (!c.hosts.length) body.createDiv({ cls: "aos-con-banner", text: "No host is on for this vault: Settings ▸ Hosts adds Claude Code or Codex." });
  for (const h of c.hosts) {
    const x = b.hosts[h];
    if (x.checked || !x.error) continue;
    const ban = body.createDiv({ cls: "aos-con-banner is-warn", attr: { "data-host": h } });
    ban.createSpan({ cls: `aos-con-dot is-${h}`, attr: { "aria-hidden": "true" } });
    ban.createSpan({ text: `${CONN_HOST_LABEL[h]} could not be checked: ${x.error}. Its servers show what the config files say.` });
  }

  const shown = visible(c);
  drawTiles(body, c);

  // NEEDS ATTENTION, always drawn (the tour's anchor): a calm line when nothing failed.
  const att = b.groups.attention.filter((k) => shown.has(k.key));
  const attSec = section(body, "attention", `NEEDS ATTENTION · ${att.length}`, null, { tour: "connectors-attention", danger: att.length > 0 });
  if (!att.length) attSec.createEl("p", { cls: "aos-con-none", text: filtering(c) ? "No card that needs attention matches." : b.checkedAt ? "Nothing needs attention after the last check." : "Nothing to report until the first check." });
  else {
    const grid = attSec.createDiv({ cls: "aos-con-alerts" });
    for (const k of att) drawAlert(grid, k, c);
  }

  const cons = b.groups.connectors.filter((k) => shown.has(k.key));
  const conNote = c.hosts.map((h) => (h === "claude" ? "claude.ai for Claude Code" : "ChatGPT apps for Codex")).join(" · ");
  const conSec = section(body, "connectors", `CONNECTORS · ${cons.length}`, conNote || null);
  if (!cons.length) conSec.createEl("p", { cls: "aos-con-none", text: filtering(c) ? "No connector matches." : "No connector yet: they come from your claude.ai account and Codex's ChatGPT apps." });
  else {
    const grid = conSec.createDiv({ cls: "aos-con-grid is-connectors" });
    for (const k of cons) drawConnector(grid, k, c);
  }

  const srvs = b.groups.servers.filter((k) => shown.has(k.key));
  const srvSec = section(body, "servers", `MCP SERVERS · ${srvs.length}`, `bars are calls per day, ${b.days} days`, { tour: "connectors-servers" });
  if (!srvs.length) srvSec.createEl("p", { cls: "aos-con-none", text: filtering(c) ? "No server matches." : `No MCP server on ${c.hosts.map((h) => CONN_HOST_LABEL[h]).join(" or ") || "an enabled host"} yet.` });
  else {
    const grid = srvSec.createDiv({ cls: "aos-con-grid is-servers" });
    for (const k of srvs) drawServer(grid, k, c);
  }

  const more = body.createEl("section", { cls: "aos-con-more", attr: { "aria-label": "More" } });
  for (const f of FOLDS) {
    const ks = b.groups[f.group].filter((k) => shown.has(k.key));
    const open = c.folds.has(f.group) || (filtering(c) && ks.length > 0);
    const wrap = more.createDiv({ cls: `aos-con-fold${open ? " is-open" : ""}`, attr: { "data-group": f.group } });
    const head = wrap.createEl("button", {
      cls: "aos-con-foldhead", attr: { type: "button", "aria-expanded": String(open), "data-fk": `fold:${f.group}` },
    });
    const chev = head.createSpan({ cls: "aos-con-ico aos-con-chev" });
    setIcon(chev, "chevron-right");
    head.createSpan({ cls: "aos-con-foldlabel", text: f.label });
    head.createSpan({ cls: "aos-con-foldcount", text: String(ks.length) });
    head.createSpan({ cls: "aos-con-peek", text: groupPeek(ks, f.group) });
    head.addEventListener("click", () => c.on.fold(f.group));
    if (open && ks.length) {
      const grid = wrap.createDiv({ cls: "aos-con-grid is-servers" });
      for (const k of ks) (k.kind === "connector" ? drawConnector : drawServer)(grid, k, c);
    }
  }
}

function filtering(c: BoardCtx): boolean { return !!c.query.trim() || c.tile !== null; }

/** The keys a filter and a tile leave on the board. */
function visible(c: BoardCtx): Set<string> {
  return new Set(filterCards(c.board.cards, c.query).filter((k) => !c.tile || inTile(k, c.tile)).map((k) => k.key));
}

function section(parent: HTMLElement, group: ConnGroup, title: string, note: string | null, o: { tour?: string; danger?: boolean } = {}): HTMLElement {
  const sec = parent.createEl("section", { cls: `aos-con-section aos-con-${group}`, attr: { "data-group": group, ...(o.tour ? { "data-tour": o.tour } : {}) } });
  const h = sec.createEl("h2", { cls: `aos-con-h2${o.danger ? " is-danger" : ""}` });
  h.createSpan({ text: title });
  if (note) h.createSpan({ cls: "aos-con-h2note", text: note });
  return sec;
}

function drawTiles(parent: HTMLElement, c: BoardCtx): void {
  const row = parent.createDiv({ cls: "aos-con-tiles", attr: { "data-tour": "connectors-tiles", role: "group", "aria-label": "Summary" } });
  for (const t of CONN_TILES) {
    const n = c.board.tiles[t];
    const on = c.tile === t;
    const tone = t === "attention" ? (n ? " is-danger" : "") : t === "connected" ? " is-ok" : t === "off" ? " is-off" : "";
    const label = TILE_LABEL[t].replace("{days}", String(c.board.days));
    const b = row.createEl("button", {
      cls: `aos-con-tile${tone}${on ? " is-on" : ""}`,
      attr: { type: "button", "data-tile": t, "aria-pressed": String(on), "data-fk": `tile:${t}`, title: on ? "Show every card again" : `Show only: ${label.toLowerCase()}` },
    });
    b.createSpan({ cls: "aos-con-tilen", text: String(n) });
    b.createSpan({ cls: "aos-con-tilelabel", text: label });
    b.createSpan({ cls: "aos-con-tilesub", text: tileSub(c.board.cards, t, c.board.days) });
    b.addEventListener("click", () => c.on.tile(t));
  }
}

/** One dot per enabled host: filled when the card is on it, hollow when not. */
function hostDots(parent: HTMLElement, k: ConnCard, hosts: readonly ConnHost[]): void {
  const on = CONN_HOSTS.filter((h) => hosts.includes(h) && k.sides[h]);
  const label = on.length === 2 ? "On Claude Code and Codex" : on.length ? `On ${CONN_HOST_LABEL[on[0]]} only` : "On no enabled host";
  const dots = parent.createSpan({ cls: "aos-con-hosts", attr: { "aria-label": label, title: label, role: "img" } });
  for (const h of CONN_HOSTS) {
    if (!hosts.includes(h)) continue;
    dots.createSpan({ cls: `aos-con-dot is-${h}${k.sides[h] ? "" : " is-absent"}`, attr: { "data-host": h } });
  }
}

function statusDot(parent: HTMLElement, k: ConnCard): void {
  parent.createSpan({ cls: `aos-con-dot is-${statusTone(k.status)}`, attr: { role: "img", "aria-label": STATUS_LABEL[k.status], title: STATUS_LABEL[k.status] } });
}

function cardButton(parent: HTMLElement, k: ConnCard, cls: string, c: BoardCtx): HTMLElement {
  const unused = k.calls === 0 ? " is-unused" : "";
  const b = parent.createEl("button", { cls: `aos-con-card ${cls}${unused}`, attr: { type: "button", "data-conn": k.key, "data-fk": `card:${k.key}`, "aria-haspopup": "dialog" } });
  b.addEventListener("click", () => c.on.open(k));
  return b;
}

function drawConnector(grid: HTMLElement, k: ConnCard, c: BoardCtx): void {
  const b = cardButton(grid, k, "aos-con-conn", c);
  b.createSpan({ cls: "aos-con-mono", text: (k.title.trim()[0] ?? "?").toUpperCase(), attr: { "aria-hidden": "true" } });
  const words = b.createSpan({ cls: "aos-con-words" });
  words.createSpan({ cls: "aos-con-cname", text: k.title });
  words.createSpan({ cls: "aos-con-use", text: useLine(k, c.board.days, c.now) });
  hostDots(b, k, c.hosts);
}

function drawServer(grid: HTMLElement, k: ConnCard, c: BoardCtx): void {
  const b = cardButton(grid, k, "aos-con-srv", c);
  const top = b.createSpan({ cls: "aos-con-srvtop" });
  statusDot(top, k);
  top.createSpan({ cls: "aos-con-cname", text: k.title });
  hostDots(top, k, c.hosts);
  b.createSpan({ cls: "aos-con-sub", text: serverSub(k) });
  const spark = b.createSpan({ cls: "aos-con-spark", attr: { "aria-hidden": "true" } });
  for (const h of sparkHeights(k.perDay, c.board.days, SPARK_PX)) {
    const bar = spark.createSpan({ cls: `aos-con-bar${h ? " is-on" : ""}` });
    if (h) bar.style.height = `${h}px`;
  }
  const foot = b.createSpan({ cls: "aos-con-foot" });
  foot.createSpan({ text: k.toolCount === null ? "— tools" : `${k.toolCount} tool${k.toolCount === 1 ? "" : "s"}` });
  foot.createSpan({ cls: "aos-con-footuse", text: useLine(k, c.board.days, c.now) });
}

function drawAlert(grid: HTMLElement, k: ConnCard, c: BoardCtx): void {
  const fix = attentionFix(k);
  const card = grid.createDiv({ cls: "aos-con-alert", attr: { "data-conn": k.key } });
  const top = card.createDiv({ cls: "aos-con-alerttop" });
  statusDot(top, k);
  const name = top.createEl("button", { cls: "aos-con-alertname", text: k.title, attr: { type: "button", "data-fk": `card:${k.key}`, "aria-haspopup": "dialog", title: "Show its detail" } });
  name.addEventListener("click", () => c.on.open(k));
  if (fix) top.createSpan({ cls: "aos-con-kind", text: alertKind(fix.side, k) });
  if (!fix) return;
  card.createEl("p", { cls: "aos-con-reason", text: fix.side.detail || STATUS_LABEL[fix.side.status] });
  card.createEl("p", { cls: "aos-con-hint", text: fix.hint });
  const acts = card.createDiv({ cls: "aos-con-alertacts" });
  const busy = fix.fix === "check" && c.checking;
  const btn = acts.createEl("button", {
    cls: "aos-con-btn aos-con-primary aos-con-fix", text: busy ? "Checking…" : fix.label,
    attr: { type: "button", "data-fix": fix.fix, "data-fk": `fix:${k.key}` },
  });
  btn.disabled = busy;
  btn.addEventListener("click", () => c.on.fix(k));
}
