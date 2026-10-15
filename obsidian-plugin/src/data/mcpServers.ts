// mcpServers.ts — Skills ▸ MCP servers (install-import B6): both hosts' user-scope MCP servers from
// brain/_index/mcp-servers.json (the importer's listing, lib/import/mcp.js: the program or URL alone, never arguments,
// environment or headers), one row per name with the hosts that have it, and per row "Make available on <other host>"
// for an enabled host that lacks it. The page never sees a server's config: the click runs `aos mcp copy <name> --to
// <host> --dry-run --json` (cli/mcp.js), shows that exact command (every secret hidden) and the file it writes, and on
// confirm runs it for real, which backs the file up first and goes through the host's own CLI. Pure, so node:test can
// load it.

export const MCP_SERVERS_PATH = "brain/_index/mcp-servers.json";
export type McpHost = "claude" | "codex";
export const MCP_HOSTS: readonly McpHost[] = ["claude", "codex"];
export const MCP_HOST_LABEL: Record<McpHost, string> = { claude: "Claude Code", codex: "Codex" };
/** What both CLIs take as a server name (cli/mcp.js NAME_RE, and the mcp surface's rule). */
export const MCP_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;

export interface McpServerRow {
  name: string;
  host: McpHost;
  transport: "stdio" | "http" | "sse";
  command: string | null;
  url: string | null;
  enabled: boolean;
}

export interface McpCache {
  /** Whether the file was there and parsed: an install that never listed them says how to. */
  listed: boolean;
  updatedAt: string | null;
  servers: McpServerRow[];
}

export interface McpOffer {
  to: McpHost;
  label: string;
  disabled: boolean;
  reason: string | null;
}

export interface McpItem {
  name: string;
  on: Partial<Record<McpHost, McpServerRow>>;
  transport: McpServerRow["transport"];
  /** The program or the URL, as the listing has it. */
  what: string;
  offers: McpOffer[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

export function parseMcpServers(text: string | null): McpCache {
  let j: unknown;
  try { j = text ? JSON.parse(text) : null; } catch { j = null; }
  if (!isObj(j) || !Array.isArray(j.servers)) return { listed: false, updatedAt: null, servers: [] };
  const servers: McpServerRow[] = [];
  for (const s of j.servers) {
    if (!isObj(s)) continue;
    const name = str(s.name);
    const host = s.host === "claude" || s.host === "codex" ? s.host : null;
    if (!name || !host) continue;
    const transport = s.transport === "http" || s.transport === "sse" ? s.transport : "stdio";
    servers.push({ name, host, transport, command: str(s.command), url: str(s.url), enabled: s.enabled !== false });
  }
  return { listed: true, updatedAt: str(j.updatedAt), servers };
}

/**
 * One item per server name, by name: which hosts have it, and "Make available on <host>" for each enabled host that
 * lacks it while the other has it. Codex takes only a command (`codex mcp add … -- <command>`), so a remote server's
 * offer to Codex is off with why; a name either CLI would refuse is off too. A host that is off gets no offer.
 */
export function mcpItems(cache: McpCache, enabled: readonly McpHost[]): McpItem[] {
  const byName = new Map<string, McpItem>();
  for (const s of cache.servers) {
    const item = byName.get(s.name) ?? { name: s.name, on: {}, transport: s.transport, what: "", offers: [] };
    item.on[s.host] = s;
    byName.set(s.name, item);
  }
  const items = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const it of items) {
    const src = it.on.claude ?? it.on.codex!;
    it.transport = src.transport;
    it.what = src.command ?? src.url ?? "";
    for (const to of MCP_HOSTS) {
      if (it.on[to] || !enabled.includes(to)) continue;
      const from = MCP_HOSTS.find((h) => h !== to)!;
      const s = it.on[from];
      if (!s) continue;
      let reason: string | null = null;
      if (!MCP_NAME_RE.test(it.name)) reason = `${MCP_HOST_LABEL[to]}'s CLI does not take the name ${JSON.stringify(it.name)}: letters, digits, - and _ only`;
      else if (to === "codex" && s.transport !== "stdio") reason = `A remote (${s.transport}) server: \`codex mcp add\` takes a command to run, so add it in Codex's config.toml yourself`;
      it.offers.push({ to, label: `Make available on ${MCP_HOST_LABEL[to]}`, disabled: reason !== null, reason });
    }
  }
  return items;
}

/** Items whose name, program or URL holds the query (case-insensitive). */
export function filterMcp(items: readonly McpItem[], query: string): McpItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  return items.filter((i) => `${i.name}\n${i.what}`.toLowerCase().includes(q));
}

/** `aos mcp copy` as the page runs it, `--json` last; throws on a name the surface would refuse anyway. */
export function copyArgs(name: string, to: McpHost, dryRun: boolean): string[] {
  if (!MCP_NAME_RE.test(name)) throw new Error(`not a server name: ${name}`);
  if (to !== "claude" && to !== "codex") throw new Error(`not a host: ${String(to)}`);
  return ["mcp", "copy", name, "--to", to, ...(dryRun ? ["--dry-run"] : []), "--json"];
}

/** What `aos mcp copy --json` answers (cli/mcp.js copy()). */
export interface McpPlan {
  ok: boolean;
  dryRun: boolean;
  name: string;
  from: McpHost;
  to: McpHost;
  transport: string;
  /** The target command, every secret hidden. */
  command: string;
  source: string;
  file: string;
  backup: string | null;
  dropped: string[];
  disabled: boolean;
  listed?: boolean;
}

export function parsePlan(j: unknown): McpPlan | null {
  if (!isObj(j) || j.ok !== true || typeof j.command !== "string" || typeof j.file !== "string") return null;
  const host = (v: unknown): McpHost | null => (v === "claude" || v === "codex" ? v : null);
  const from = host(j.from);
  const to = host(j.to);
  if (!from || !to || typeof j.name !== "string") return null;
  return {
    ok: true, dryRun: j.dryRun === true, name: j.name, from, to, transport: String(j.transport ?? "stdio"), command: j.command,
    source: String(j.source ?? ""), file: j.file, backup: typeof j.backup === "string" ? j.backup : null,
    dropped: Array.isArray(j.dropped) ? j.dropped.map(String) : [], disabled: j.disabled === true,
    ...(typeof j.listed === "boolean" ? { listed: j.listed } : {}),
  };
}

/** The confirm a dry run gives: its title, what happens, and the exact command and file. */
export function planConfirm(p: McpPlan): { title: string; message: string; detail: string; confirm: string } {
  const lines = [
    `Writes ${p.file}`,
    p.backup ? `Backs it up first to ${p.backup}` : "No backup: the file does not exist yet",
    "",
    p.command,
  ];
  const notes = [
    `Copies ${p.name} from ${MCP_HOST_LABEL[p.from]} (${p.source}) through ${MCP_HOST_LABEL[p.to]}'s own CLI.`,
    "Environment and header values, URL queries and token-like arguments are hidden here; the command takes them from the source.",
  ];
  if (p.dropped.length) notes.push(`Not carried over: ${p.dropped.join(", ")}.`);
  if (p.disabled) notes.push(`It is turned off on ${MCP_HOST_LABEL[p.from]}; the copy is on.`);
  return { title: `Make ${p.name} available on ${MCP_HOST_LABEL[p.to]}?`, message: notes.join(" "), detail: lines.join("\n"), confirm: `Add to ${MCP_HOST_LABEL[p.to]}` };
}
