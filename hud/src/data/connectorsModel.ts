// connectorsModel.ts — the Connectors tab (spec 2026-10-23-connectors-tab D3–D5, D9, D12, D13): every MCP server and
// connector both hosts can use, from the runtime's three caches, as the health board and a card's detail sheet. The
// runtime writes them (brain/scripts/lib/connectors): connectors.json on every scan (files alone), connectors-live.json
// on each `aos mcp check` (the hosts' own lists and the runtime's probes), connectors-usage.json on every scan (calls
// from both hosts' transcripts). The page never reads a host's config. Pure, so node:test can load it.
import { MCP_NAME_RE } from "./mcpServers";

export const CONNECTORS_PATH = "brain/_index/connectors.json";
export const CONNECTORS_LIVE_PATH = "brain/_index/connectors-live.json";
export const CONNECTORS_USAGE_PATH = "brain/_index/connectors-usage.json";
export const CONNECTOR_FILES: readonly string[] = [CONNECTORS_PATH, CONNECTORS_LIVE_PATH, CONNECTORS_USAGE_PATH];

export type ConnHost = "claude" | "codex";
export const CONN_HOSTS: readonly ConnHost[] = ["claude", "codex"];
export const CONN_HOST_LABEL: Record<ConnHost, string> = { claude: "Claude Code", codex: "Codex" };
/** A side's state: the live check's, or what the files alone say before one. */
export type ConnStatus = "connected" | "failed" | "needs-auth" | "pending" | "off" | "unknown" | "builtin" | "not-checked";
export type ConnGroup = "attention" | "connectors" | "servers" | "builtin" | "off" | "project";
/** The badge only counts a check this recent (D5). */
export const BADGE_FRESH_MS = 24 * 60 * 60 * 1000;
const CLAUDE_AI = "claude.ai ";

export interface ToolInfo { name: string; summary: string }

export interface FoundRow {
  host: ConnHost; name: string; kind: "server" | "connector"; transport: "stdio" | "http" | "sse"; command: string | null; url: string | null;
  scope: "user" | "local" | "project" | "plugin" | "account"; file: string | null; enabled: boolean; plugin: string | null; workspace: string | null;
  approval: "approved" | "pending" | "off" | null; own: boolean; displayName: string | null; unverified: boolean;
  /** Taken off its host by `aos mcp park`, its exact entry kept (D16): Turn on puts it back. */
  parked: boolean;
}
export interface LiveRow { host: ConnHost; name: string; kind: string; status: ConnStatus; detail: string; tools: ToolInfo[] | null; toolsError: string | null }
export interface UsageRow { host: ConnHost; key: string; name: string; builtin: boolean; calls: number; sessions: number; lastUsed: string | null; perDay: number[]; perTool: Record<string, number> }
export interface HostCheck { enabled: boolean; ran: boolean; error: string | null }

export interface ConnCaches {
  /** connectors.json was there and parsed (a runtime before 2.2 writes none: the tab asks for `aos upgrade`). */
  listed: boolean;
  found: FoundRow[];
  /** connectors-live.json: null before the first check. */
  live: { checkedAt: string | null; durationMs: number; hosts: Partial<Record<ConnHost, HostCheck>>; rows: LiveRow[] } | null;
  usage: { days: number; rows: UsageRow[] };
}

export interface ConnSide {
  host: ConnHost;
  /** The name as its host has it (`claude.ai Mail`, `plugin:p:s`, `docs`). */
  name: string;
  status: ConnStatus;
  detail: string;
  scope: FoundRow["scope"] | "builtin";
  file: string | null;
  plugin: string | null;
  workspace: string | null;
  transport: FoundRow["transport"] | null;
  what: string;
  enabled: boolean;
  own: boolean;
  /** Parked (D16): off its host, Turn on puts it back. */
  parked: boolean;
  tools: ToolInfo[] | null;
  /** The tools are the ones seen in use (D12): the check could not list them. */
  toolsSeen: boolean;
  toolsError: string | null;
  usage: UsageRow | null;
}

export interface ConnCard {
  key: string;
  title: string;
  kind: "server" | "connector" | "builtin";
  group: ConnGroup;
  sides: Partial<Record<ConnHost, ConnSide>>;
  /** The worst state across its sides: what its dot shows. */
  status: ConnStatus;
  calls: number;
  sessions: number;
  lastUsed: string | null;
  perDay: number[];
  toolCount: number | null;
}

export interface CopyOffer { to: ConnHost; label: string; disabled: boolean; reason: string | null }

export interface ConnBoard {
  listed: boolean;
  checkedAt: string | null;
  hosts: Record<ConnHost, { enabled: boolean; checked: boolean; error: string | null; count: number }>;
  tiles: { attention: number; connected: number; unused: number; off: number };
  groups: Record<ConnGroup, ConnCard[]>;
  cards: ConnCard[];
  days: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const host = (v: unknown): ConnHost | null => (v === "claude" || v === "codex" ? v : null);
const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const STATUSES = new Set<ConnStatus>(["connected", "failed", "needs-auth", "pending", "off", "unknown"]);

function json(text: string | null): unknown {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

/** The three caches, as read; anything malformed is left out, never thrown. */
export function parseCaches(found: string | null, live: string | null, usage: string | null): ConnCaches {
  const f = json(found);
  const rows: FoundRow[] = [];
  if (isObj(f) && Array.isArray(f.rows)) {
    for (const r of f.rows) {
      if (!isObj(r)) continue;
      const h = host(r.host);
      const name = str(r.name);
      if (!h || !name) continue;
      const scope = (["user", "local", "project", "plugin", "account"] as const).find((s) => s === r.scope) ?? "user";
      rows.push({
        host: h, name, kind: r.kind === "connector" ? "connector" : "server",
        transport: r.transport === "http" || r.transport === "sse" ? r.transport : "stdio",
        command: str(r.command), url: str(r.url), scope, file: str(r.file), enabled: r.enabled !== false,
        plugin: str(r.plugin), workspace: str(r.workspace),
        approval: r.approval === "approved" || r.approval === "pending" || r.approval === "off" ? r.approval : null,
        own: r.own === true, displayName: str(r.displayName), unverified: r.unverified === true, parked: r.parked === true,
      });
    }
  }
  const l = json(live);
  let liveOut: ConnCaches["live"] = null;
  if (isObj(l) && Array.isArray(l.rows)) {
    const hosts: Partial<Record<ConnHost, HostCheck>> = {};
    if (isObj(l.hosts)) for (const h of CONN_HOSTS) { const x = l.hosts[h]; if (isObj(x)) hosts[h] = { enabled: x.enabled !== false, ran: x.ran === true, error: str(x.error) }; }
    const lrows: LiveRow[] = [];
    for (const r of l.rows) {
      if (!isObj(r)) continue;
      const h = host(r.host);
      const name = str(r.name);
      if (!h || !name) continue;
      const status = STATUSES.has(r.status as ConnStatus) ? (r.status as ConnStatus) : "unknown";
      const tools = Array.isArray(r.tools) ? r.tools.filter(isObj).map((t) => ({ name: String(t.name ?? ""), summary: String(t.summary ?? "") })).filter((t) => t.name) : null;
      lrows.push({ host: h, name, kind: String(r.kind ?? "server"), status, detail: String(r.detail ?? ""), tools, toolsError: str(r.toolsError) });
    }
    liveOut = { checkedAt: str(l.checkedAt), durationMs: num(l.durationMs), hosts, rows: lrows };
  }
  const u = json(usage);
  const urows: UsageRow[] = [];
  let days = 30;
  if (isObj(u) && Array.isArray(u.rows)) {
    days = Math.max(1, Math.floor(num(u.days, 30)));
    for (const r of u.rows) {
      if (!isObj(r)) continue;
      const h = host(r.host);
      const name = str(r.name);
      if (!h || !name) continue;
      const perTool: Record<string, number> = {};
      if (isObj(r.perTool)) for (const [k, v] of Object.entries(r.perTool)) if (num(v) > 0) perTool[k] = num(v);
      urows.push({
        host: h, key: str(r.key) ?? name, name, builtin: r.builtin === true, calls: num(r.calls), sessions: num(r.sessions),
        lastUsed: str(r.lastUsed), perDay: Array.isArray(r.perDay) ? r.perDay.map((x) => num(x)) : [], perTool,
      });
    }
  }
  return { listed: isObj(f) && Array.isArray(f.rows), found: rows, live: liveOut, usage: { days, rows: urows } };
}

/** A Claude Code plugin server's own name (`plugin:<plugin>:<server>` → `<server>`). */
function serverName(r: { host: ConnHost; name: string; scope?: string }): string {
  if (r.host === "claude" && r.scope === "plugin") { const m = /^plugin:[^:]+:(.+)$/.exec(r.name); if (m) return m[1]; }
  return r.name;
}
/** A connector's title: claude.ai's without the prefix, a Codex app's display name. */
function connectorTitle(r: FoundRow): string {
  return r.displayName ?? (r.name.startsWith(CLAUDE_AI) ? r.name.slice(CLAUDE_AI.length) : r.name);
}

/** Which card a row joins (D9): servers by name, connectors by title, project servers per workspace, case aside. */
function cardKey(r: FoundRow): string {
  if (r.kind === "connector") return `c:${connectorTitle(r).toLowerCase()}`;
  if (r.scope === "project" || r.scope === "local") return `p:${r.workspace ?? ""}:${r.name.toLowerCase()}`;
  return `s:${serverName(r).toLowerCase()}`;
}

/** Worst first: what a card's dot shows. */
const RANK: ConnStatus[] = ["failed", "needs-auth", "unknown", "pending", "not-checked", "connected", "builtin", "off"];
function worst(a: ConnStatus, b: ConnStatus): ConnStatus { return RANK.indexOf(a) <= RANK.indexOf(b) ? a : b; }

function addDays(into: number[], from: number[]): number[] {
  const n = Math.max(into.length, from.length);
  const out = new Array<number>(n).fill(0);
  // Align on the newest day (the arrays end today).
  for (let i = 0; i < into.length; i++) out[n - into.length + i] += into[i];
  for (let i = 0; i < from.length; i++) out[n - from.length + i] += from[i];
  return out;
}

/** The board: every card in one group (attention, then off, project, built-in, connector, server), the tiles and hosts. */
export function buildBoard(c: ConnCaches, enabled: readonly ConnHost[]): ConnBoard {
  const live = new Map<string, LiveRow>();
  for (const r of c.live?.rows ?? []) live.set(`${r.host}\t${r.name}`, r);
  const used = new Map<string, UsageRow>();
  for (const r of c.usage.rows) used.set(`${r.host}\t${r.name}`, r);
  const checked = c.live !== null;
  const cards = new Map<string, ConnCard>();
  const card = (key: string, title: string, kind: ConnCard["kind"]): ConnCard => {
    const have = cards.get(key);
    if (have) return have;
    const fresh: ConnCard = { key, title, kind, group: "servers", sides: {}, status: "off", calls: 0, sessions: 0, lastUsed: null, perDay: [], toolCount: null };
    cards.set(key, fresh);
    return fresh;
  };
  const seen = new Set<string>();
  for (const r of c.found) {
    if (!enabled.includes(r.host)) continue;
    seen.add(`${r.host}\t${r.name}`);
    const l = live.get(`${r.host}\t${r.name}`);
    const u = used.get(`${r.host}\t${r.name}`) ?? null;
    let status: ConnStatus = l ? l.status : checked && !r.unverified ? "unknown" : "not-checked";
    let detail = l?.detail ?? (r.unverified ? "not checked yet" : "");
    if (r.parked) { status = "off"; detail = "parked: Turn on puts it back as it was"; }
    else if (!r.enabled) { status = "off"; detail = detail || (r.approval === "off" ? "turned off for this project" : "turned off"); }
    else if (r.approval === "pending" && !l) { status = "pending"; detail = "waiting for approval in Claude Code"; }
    const liveTools = l?.tools ?? null;
    const seenTools = u && Object.keys(u.perTool).length ? Object.keys(u.perTool).sort().map((name) => ({ name, summary: "" })) : null;
    const side: ConnSide = {
      host: r.host, name: r.name, status, detail, scope: r.scope, file: r.file, plugin: r.plugin, workspace: r.workspace,
      transport: r.kind === "connector" ? null : r.transport, what: r.command ?? r.url ?? "", enabled: r.enabled, own: r.own, parked: r.parked,
      tools: liveTools ?? seenTools, toolsSeen: !liveTools && !!seenTools, toolsError: l?.toolsError ?? null, usage: u,
    };
    const k = card(cardKey(r), r.kind === "connector" ? connectorTitle(r) : serverName(r), r.kind);
    k.sides[r.host] = side;
  }
  // A claude.ai connector a check named that the list has not caught up with yet.
  for (const r of c.live?.rows ?? []) {
    if (!enabled.includes(r.host) || seen.has(`${r.host}\t${r.name}`) || r.kind !== "connector") continue;
    const title = r.name.startsWith(CLAUDE_AI) ? r.name.slice(CLAUDE_AI.length) : r.name;
    card(`c:${title.toLowerCase()}`, title, "connector").sides[r.host] = {
      host: r.host, name: r.name, status: r.status, detail: r.detail, scope: "account", file: null, plugin: null, workspace: null, transport: null,
      what: "", enabled: true, own: false, parked: false, tools: null, toolsSeen: false, toolsError: null, usage: used.get(`${r.host}\t${r.name}`) ?? null,
    };
  }
  // Built-ins: servers the sessions called that no file declares (D13).
  for (const u of c.usage.rows) {
    if (!u.builtin || !enabled.includes(u.host)) continue;
    const tools = Object.keys(u.perTool).sort().map((name) => ({ name, summary: "" }));
    card(`b:${u.name.toLowerCase()}`, u.name, "builtin").sides[u.host] = {
      host: u.host, name: u.name, status: "builtin", detail: `built into ${CONN_HOST_LABEL[u.host]}`, scope: "builtin", file: null, plugin: null,
      workspace: null, transport: null, what: "", enabled: true, own: false, parked: false, tools, toolsSeen: true, toolsError: null, usage: u,
    };
  }

  const out = [...cards.values()];
  for (const k of out) {
    const sides = Object.values(k.sides) as ConnSide[];
    k.status = sides.reduce<ConnStatus>((s, x) => worst(s, x.status), "off");
    k.calls = sides.reduce((n, x) => n + (x.usage?.calls ?? 0), 0);
    k.sessions = sides.reduce((n, x) => n + (x.usage?.sessions ?? 0), 0);
    k.lastUsed = sides.map((x) => x.usage?.lastUsed ?? null).filter((x): x is string => !!x).sort().pop() ?? null;
    k.perDay = sides.reduce<number[]>((d, x) => (x.usage ? addDays(d, x.usage.perDay) : d), []);
    const names = new Set<string>();
    let any = false;
    for (const x of sides) if (x.tools) { any = true; for (const t of x.tools) names.add(t.name); }
    k.toolCount = any ? names.size : null;
    const project = sides.some((x) => x.scope === "project" || x.scope === "local");
    k.group = sides.some((x) => x.status === "failed" || x.status === "needs-auth") ? "attention"
      : sides.every((x) => x.status === "off") ? "off"
        : project ? "project" : k.kind === "builtin" ? "builtin" : k.kind === "connector" ? "connectors" : "servers";
  }
  out.sort((a, b) => b.calls - a.calls || a.title.localeCompare(b.title));
  const groups: Record<ConnGroup, ConnCard[]> = { attention: [], connectors: [], servers: [], builtin: [], off: [], project: [] };
  for (const k of out) groups[k.group].push(k);

  const hostInfo = {} as ConnBoard["hosts"];
  for (const h of CONN_HOSTS) {
    const x = c.live?.hosts[h];
    hostInfo[h] = { enabled: enabled.includes(h), checked: !!x?.ran, error: x?.error ?? null, count: out.filter((k) => k.sides[h]).length };
  }
  return {
    listed: c.listed, checkedAt: c.live?.checkedAt ?? null, hosts: hostInfo, cards: out, groups, days: c.usage.days,
    tiles: {
      attention: out.filter((k) => inTile(k, "attention")).length,
      connected: out.filter((k) => inTile(k, "connected")).length,
      unused: out.filter((k) => inTile(k, "unused")).length,
      off: out.filter((k) => inTile(k, "off")).length,
    },
  };
}

/** The summary tiles (D3), in board order. */
export type ConnTile = "attention" | "connected" | "unused" | "off";
export const CONN_TILES: readonly ConnTile[] = ["attention", "connected", "unused", "off"];

/** Whether a card counts toward a tile: what the tile's number counts, and what a click on it keeps. Unused counts every
 *  card not off with no call in the window, failing ones too (they are the first candidates to park). */
export function inTile(k: ConnCard, tile: ConnTile): boolean {
  if (tile === "attention") return k.group === "attention";
  if (tile === "off") return k.group === "off";
  if (tile === "unused") return k.group !== "off" && k.calls === 0;
  return k.group !== "off" && k.group !== "attention" && (Object.values(k.sides) as ConnSide[]).some((x) => x.status === "connected" || x.status === "builtin");
}

/** Whether the tab should check now: never checked, or the last check is older than `everyMin` minutes. */
export function checkDue(board: Pick<ConnBoard, "checkedAt">, nowMs: number, everyMin: number): boolean {
  const at = board.checkedAt ? Date.parse(board.checkedAt) : NaN;
  return !Number.isFinite(at) || nowMs - at >= Math.max(1, everyMin) * 60_000;
}

/** The rail badge (D5): what needs attention after a check within a day; 0 otherwise. */
export function connectorsBadge(board: Pick<ConnBoard, "checkedAt" | "tiles">, nowMs: number): number {
  const at = board.checkedAt ? Date.parse(board.checkedAt) : NaN;
  if (!Number.isFinite(at) || nowMs - at > BADGE_FRESH_MS) return 0;
  return board.tiles.attention;
}

/** Cards whose title, host names, programs, plugins or tools hold the query (case-insensitive). */
export function filterCards(cards: readonly ConnCard[], query: string): ConnCard[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...cards];
  return cards.filter((k) => {
    const sides = Object.values(k.sides) as ConnSide[];
    const hay = [k.title, ...sides.flatMap((x) => [x.name, x.what, x.plugin ?? "", x.workspace ?? "", ...(x.tools ?? []).map((t) => t.name)])].join("\n").toLowerCase();
    return hay.includes(q);
  });
}

// ── words ────────────────────────────────────────────────────────────────────

export const STATUS_LABEL: Record<ConnStatus, string> = {
  connected: "Connected", failed: "Failed", "needs-auth": "Needs sign-in", pending: "Pending approval", off: "Off",
  unknown: "Unknown", builtin: "Built in", "not-checked": "Not checked",
};
/** The CSS tone of a state (D23: colour only for state). */
export function statusTone(s: ConnStatus): "ok" | "danger" | "warn" | "off" | "info" {
  return s === "connected" || s === "builtin" ? "ok" : s === "failed" ? "danger" : s === "needs-auth" || s === "pending" ? "warn" : s === "unknown" || s === "not-checked" ? "info" : "off";
}

/** A card's kind line: `Local · stdio`, `Remote · http`, `Connector`, `Built in`. */
export function kindLine(k: ConnCard): string {
  if (k.kind === "connector") return "Connector";
  if (k.kind === "builtin") return "Built in";
  const s = (Object.values(k.sides) as ConnSide[]).find((x) => x.transport);
  return s?.transport === "stdio" ? "Local · stdio" : `Remote · ${s?.transport ?? "http"}`;
}

/** Where a side comes from, in words: `user · ~/.claude.json`, `plugin agenticos`, `project alpha · pending`. */
export function scopeLine(x: ConnSide): string {
  if (x.scope === "builtin") return `built into ${CONN_HOST_LABEL[x.host]}`;
  if (x.scope === "account") return x.host === "claude" ? "claude.ai account" : `ChatGPT app${x.plugin ? ` · plugin ${x.plugin}` : ""}`;
  if (x.scope === "plugin") return `plugin ${x.plugin ?? ""}${x.own ? " · this vault's own" : ""}`.trim();
  if (x.scope === "project" || x.scope === "local") return `${x.scope} · ${x.workspace ?? ""}${x.file ? ` · ${x.file}` : ""}`;
  if (x.parked) return `user · parked${x.file ? ` · Turn on puts it back in ${x.file}` : ""}`;
  return `user${x.file ? ` · ${x.file}` : ""}`;
}

/** "3h", "11d", "—": the compact age a card shows. */
export function ageShort(iso: string | null, nowMs: number): string {
  if (!iso) return "—";
  const ms = nowMs - Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** A card's use, in a few words: `64 calls · 2h ago`, or `unused 30d`. */
export function useLine(k: ConnCard, days: number, nowMs: number): string {
  if (!k.calls) return `unused ${days}d`;
  return `${k.calls} call${k.calls === 1 ? "" : "s"} · ${ageShort(k.lastUsed, nowMs)} ago`;
}

/**
 * What a card needing attention suggests: a sentence and the one fix the tab offers (a sheet's Park and Remove are the
 * other ways out, sideActions). `fix` names the button: `claude.ai` opens claude.ai's connectors page; `login` runs
 * `codex mcp login <name>` in a Code terminal; `check` checks again.
 */
export function attentionFix(k: ConnCard): { side: ConnSide; hint: string; fix: "claude.ai" | "login" | "check"; label: string } | null {
  const side = (Object.values(k.sides) as ConnSide[]).find((x) => x.status === "failed" || x.status === "needs-auth");
  if (!side) return null;
  if (side.host === "claude" && side.scope === "account") {
    return { side, hint: side.status === "needs-auth" ? "This connector needs signing in again on claude.ai." : "The connector refused Claude Code. Reconnect it on claude.ai, or turn it off there.", fix: "claude.ai", label: "Open claude.ai connectors" };
  }
  if (side.host === "codex" && side.status === "needs-auth" && side.scope !== "account") {
    return { side, hint: `${side.name} signs in with OAuth: codex mcp login opens your browser to finish.`, fix: "login", label: "Sign in with Codex" };
  }
  if (side.status === "needs-auth") return { side, hint: `Sign in from /mcp in a ${CONN_HOST_LABEL[side.host]} session.`, fix: "check", label: "Check again" };
  return { side, hint: `${CONN_HOST_LABEL[side.host]} could not start or reach it. The check tries again every few minutes while this tab is open.`, fix: "check", label: "Check again" };
}

/**
 * "Copy to <host>" for a server card (D20, the copy Skills offered): a user-scope server on one enabled host that the
 * other enabled host lacks. Codex's `mcp add --url` takes a streamable HTTP server, so an SSE server's offer to Codex is
 * off with why, and so is a parked or turned-off one's.
 */
export function copyOffers(k: ConnCard, enabled: readonly ConnHost[]): CopyOffer[] {
  if (k.kind !== "server") return [];
  const out: CopyOffer[] = [];
  for (const to of CONN_HOSTS) {
    if (k.sides[to] || !enabled.includes(to)) continue;
    const from = CONN_HOSTS.find((h) => h !== to)!;
    const s = k.sides[from];
    if (!s || s.scope !== "user" || s.own) continue;
    let reason: string | null = null;
    if (!MCP_NAME_RE.test(s.name)) reason = `${CONN_HOST_LABEL[to]}'s CLI does not take the name ${JSON.stringify(s.name)}: letters, digits, - and _ only`;
    else if (s.parked) reason = `Parked on ${CONN_HOST_LABEL[from]}: turn it on there first`;
    else if (!s.enabled) reason = `Turned off on ${CONN_HOST_LABEL[from]}: turn it on there first`;
    else if (to === "codex" && s.transport === "sse") reason = "An SSE server: Codex's mcp add --url takes a streamable HTTP server only";
    out.push({ to, label: `Copy to ${CONN_HOST_LABEL[to]}`, disabled: reason !== null, reason });
  }
  return out;
}

export type ManageVerb = "park" | "unpark" | "remove";

/**
 * What a sheet's host row offers for one side (D16, D17): a user-scope server Park and Remove (only Remove when it is
 * off: Turn on could not bring that state back), a parked one Turn on; every other row says what to do instead, and the
 * vault's own server and a built-in neither.
 */
export function sideActions(x: ConnSide): { actions: ManageVerb[]; hint: string | null } {
  const none = (hint: string | null) => ({ actions: [] as ManageVerb[], hint });
  if (x.scope === "builtin") return none(null);
  if (x.own) return none("The vault's own server: aos init and aos hosts add wire it on each host.");
  if (x.scope === "account") {
    return none(x.host === "claude" ? "A claude.ai connector: turn it off in claude.ai's connector settings." : "A ChatGPT app: turn it off in ChatGPT's connector settings.");
  }
  if (x.scope === "plugin") {
    return none(x.host === "claude"
      ? `From the plugin ${x.plugin ?? ""}: turn the plugin off with claude plugin disable ${x.plugin ?? ""} (that turns off its skills too).`
      : `From the Codex plugin ${x.plugin ?? ""}: Codex has no command for it, so turn the plugin off in Codex's plugin settings.`);
  }
  if (x.scope === "project" || x.scope === "local") return none(`Declared by the workspace ${x.workspace ?? ""}: change it in ${x.file ?? "its config"}.`);
  if (!MCP_NAME_RE.test(x.name)) return none(`${CONN_HOST_LABEL[x.host]}'s CLI does not take the name ${JSON.stringify(x.name)}: change it in ${x.file ?? "its config"}.`);
  if (x.parked) return { actions: ["unpark"], hint: null };
  if (!x.enabled) return { actions: ["remove"], hint: null };
  return { actions: ["park", "remove"], hint: null };
}

/** The user-scope names each enabled host has, parked ones included: what Add server would clash with. */
export function takenNames(b: Pick<ConnBoard, "cards">): Record<ConnHost, Set<string>> {
  const out: Record<ConnHost, Set<string>> = { claude: new Set(), codex: new Set() };
  for (const k of b.cards) for (const x of Object.values(k.sides) as ConnSide[]) if (x.scope === "user") out[x.host].add(x.name);
  return out;
}

/** Tool chips for the sheet: every side's tools once, with the calls each had in the window, most used first. */
export function toolChips(k: ConnCard): { name: string; calls: number; summary: string }[] {
  const by = new Map<string, { name: string; calls: number; summary: string }>();
  for (const x of Object.values(k.sides) as ConnSide[]) {
    for (const t of x.tools ?? []) { const have = by.get(t.name); by.set(t.name, { name: t.name, calls: have?.calls ?? 0, summary: have?.summary || t.summary }); }
    for (const [name, n] of Object.entries(x.usage?.perTool ?? {})) { const have = by.get(name); by.set(name, { name, calls: (have?.calls ?? 0) + n, summary: have?.summary ?? "" }); }
  }
  return [...by.values()].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
}


// ── the board's words (views/ConnectorsTab.ts renders them) ──────────────────

export const TILE_LABEL: Record<ConnTile, string> = { attention: "Need attention", connected: "Connected", unused: "Unused in {days} days", off: "Off" };

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** A tile's second line: what its cards are (`2 connectors · 1 server`), or for Unused what it means. */
export function tileSub(cards: readonly ConnCard[], tile: ConnTile, days: number): string {
  const ks = cards.filter((k) => inTile(k, tile));
  if (tile === "unused") return ks.length ? `no call in ${days} days` : "everything was used";
  if (!ks.length) return tile === "attention" ? "nothing failed" : "none";
  const parts: string[] = [];
  const n = (kind: ConnCard["kind"]) => ks.filter((k) => k.kind === kind).length;
  if (n("connector")) parts.push(plural(n("connector"), "connector"));
  if (n("server")) parts.push(plural(n("server"), "server"));
  if (n("builtin")) parts.push(`${n("builtin")} built in`);
  return parts.join(" · ");
}

/** "just now", "2 min ago", "3 h ago", "4 d ago": the header's age of the last check. */
export function agoWords(iso: string | null, nowMs: number): string {
  const ms = iso ? nowMs - Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return "never";
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

/**
 * The header's mono line (D3): `checked 2 min ago · next check in 13 min · Claude Code 4 · Codex 2`, the hosts being
 * the enabled ones with how many cards each has. While a check runs it leads with `Checking…`; after an automatic check
 * failed, with why.
 */
export function metaLine(b: Pick<ConnBoard, "checkedAt" | "hosts">, nowMs: number, everyMin: number, o: { checking?: boolean; failed?: string | null } = {}): string {
  const parts: string[] = [];
  if (o.checking) parts.push("Checking…");
  else if (o.failed) parts.push(`last check failed: ${o.failed}`);
  else if (!b.checkedAt) parts.push("never checked");
  else {
    parts.push(`checked ${agoWords(b.checkedAt, nowMs)}`);
    const left = Math.ceil((Date.parse(b.checkedAt) + Math.max(1, everyMin) * 60_000 - nowMs) / 60_000);
    parts.push(left > 0 ? `next check in ${left} min` : "check due");
  }
  for (const h of CONN_HOSTS) if (b.hosts[h].enabled) parts.push(`${CONN_HOST_LABEL[h]} ${b.hosts[h].count}`);
  return parts.join(" · ");
}

/** A sparkline's bar heights (px) over `days` days, oldest first: 0 for a day with no call, else at least `minPx`. */
export function sparkHeights(perDay: readonly number[], days: number, maxPx: number, minPx = 3): number[] {
  const n = Math.max(1, days);
  const d = perDay.length >= n ? perDay.slice(perDay.length - n) : [...new Array<number>(n - perDay.length).fill(0), ...perDay];
  const max = Math.max(1, ...d);
  return d.map((x) => (x > 0 ? Math.max(minPx, Math.round((x / max) * maxPx)) : 0));
}

/** The side a card's words come from: Claude Code's when it has one. */
function firstSide(k: ConnCard): ConnSide | null {
  return k.sides.claude ?? k.sides.codex ?? null;
}

/** A server card's sub line: `plugin · logbook`, `project · alpha`, `stdio · npx`, `http · charts.example.com`. */
export function serverSub(k: ConnCard): string {
  const s = firstSide(k);
  if (!s) return "";
  if (s.scope === "builtin") return scopeLine(s);
  if (s.scope === "plugin") return `plugin · ${s.plugin ?? ""}`.trim();
  if (s.scope === "project" || s.scope === "local") return `${s.scope} · ${s.workspace ?? ""}`;
  let what = s.what;
  if (/^https?:\/\//.test(what)) { try { what = new URL(what).host; } catch { /* as written */ } }
  else what = (what.split(/\s+/)[0] ?? "").split("/").pop() ?? what;
  return `${s.transport ?? "stdio"}${what ? ` · ${what}` : ""}`;
}

/** An attention card's kind: `claude.ai connector`, `ChatGPT app`, `stdio · Claude Code`. */
export function alertKind(x: ConnSide, k: ConnCard): string {
  if (k.kind === "connector") return x.host === "claude" ? "claude.ai connector" : "ChatGPT app";
  return `${x.transport ?? "stdio"} · ${CONN_HOST_LABEL[x.host]}`;
}

/** Whether a card is on both hosts (the sheet's tag). */
export function onBoth(k: ConnCard): boolean {
  return !!k.sides.claude && !!k.sides.codex;
}

/** The files a card's sides were found in, each once, in host order. */
export function foundFiles(k: ConnCard): string[] {
  const out: string[] = [];
  for (const h of CONN_HOSTS) { const f = k.sides[h]?.file; if (f && !out.includes(f)) out.push(f); }
  return out;
}

/** A folded group's peek: the first few titles, or why it is empty. */
export function groupPeek(cards: readonly ConnCard[], group: "builtin" | "off" | "project"): string {
  if (!cards.length) return group === "builtin" ? "no built-in server was seen in use" : group === "off" ? "nothing is turned off" : "no workspace declares its own servers";
  const names = cards.slice(0, 3).map((k) => k.title).join(" · ");
  return cards.length > 3 ? `${names} · +${cards.length - 3}` : names;
}
