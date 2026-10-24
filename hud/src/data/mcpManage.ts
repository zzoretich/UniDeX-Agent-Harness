// mcpManage.ts — the Connectors tab's Park, Turn on, Remove and Add server (spec 2026-10-23-connectors-tab D16–D18, A1,
// A2): the argv the page runs (`aos mcp park|unpark|remove <name> --host <host>` and `aos mcp add …`, each first as a dry
// run, `--dry-run --json`, then for real naming the dry run's hash, `--expect <hash> --json`: the `mcp-manage` surface's
// rules, app/src/shared/surfaces.ts), the dry run's answer as a plan for exactly what was asked, the confirm's words,
// the Add sheet's form checked, and the command a Code terminal would type when the surface is off. The page never sees
// a server's config or a secret's value: Add takes a secret as `NAME ← $VAR`, a variable's name, which the host reads
// from the environment when the server starts. Pure, so node:test can load it.
import { MCP_HASH_RE, MCP_HOST_LABEL, MCP_NAME_RE, type McpHost } from "./mcpServers";

export type HostVerb = "park" | "unpark" | "remove";
export type AddTo = McpHost | "both";
/** A variable's name as Add takes it: upper case, digits and _ (the convention, and no pasted token passes it). */
export const VAR_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
/** An environment key the server reads: any variable name. */
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** The surface's limits (app/src/shared/surfaces.ts MCP_MAX_ARGS, MCP_MAX_ENV). */
export const MAX_ARGS = 32;
export const MAX_ENV = 16;
const OWN = "agenticos";
/** Shapes of a token pasted where a name belongs (lib/import/mcp.js TOKEN_SHAPE, its upper-case part). */
const TOKEN_SHAPE = /^(?:AKIA|ASIA|GH[POUSR]_|GITHUB_PAT_|SK_|RK_|PK_LIVE|XOX[ABPSR]_)/;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const host = (v: unknown): McpHost | null => (v === "claude" || v === "codex" ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** `aos mcp park|unpark|remove` as the page runs it, `--json` last. Throws on what the surface would refuse anyway. */
export function hostArgs(verb: HostVerb, name: string, h: McpHost, dryRun: boolean, expect?: string | null): string[] {
  if (verb !== "park" && verb !== "unpark" && verb !== "remove") throw new Error(`not a verb: ${String(verb)}`);
  if (!MCP_NAME_RE.test(name)) throw new Error(`not a server name: ${name}`);
  if (h !== "claude" && h !== "codex") throw new Error(`not a host: ${String(h)}`);
  if (dryRun) return ["mcp", verb, name, "--host", h, "--dry-run", "--json"];
  if (typeof expect !== "string" || !MCP_HASH_RE.test(expect)) throw new Error(`a real ${verb} needs the dry run's hash`);
  return ["mcp", verb, name, "--host", h, "--expect", expect, "--json"];
}

/** A new server as the Add sheet describes it, checked (checkAdd). */
export interface AddSpec {
  name: string;
  to: AddTo;
  kind: "local" | "remote";
  /** A local server's program and its arguments. */
  command: string;
  args: string[];
  /** A remote server's URL, and the variable holding its bearer token (or null). */
  url: string;
  bearer: string | null;
  /** A local server's secrets and settings: the key the server reads ← the variable it comes from. */
  env: { key: string; var: string }[];
}

/** `aos mcp add` as the page runs it: one flag then its value, in the surface's one order, `--json` last. */
export function addArgs(s: AddSpec, dryRun: boolean, expect?: string | null): string[] {
  if (!MCP_NAME_RE.test(s.name)) throw new Error(`not a server name: ${s.name}`);
  if (s.to !== "claude" && s.to !== "codex" && s.to !== "both") throw new Error(`not a target: ${String(s.to)}`);
  const out = ["mcp", "add", s.name, "--to", s.to];
  if (s.kind === "local") {
    out.push("--command", s.command);
    for (const a of s.args) out.push("--arg", a);
    for (const e of s.env) out.push("--env", `${e.key}=$${e.var}`);
  } else {
    out.push("--url", s.url);
    if (s.bearer) out.push("--bearer-env", `$${s.bearer}`);
  }
  if (dryRun) return [...out, "--dry-run", "--json"];
  if (typeof expect !== "string" || !MCP_HASH_RE.test(expect)) throw new Error("a real add needs the dry run's hash");
  return [...out, "--expect", expect, "--json"];
}

/** A word as a shell would need it typed: single-quoted unless it is plain (so `$VAR` stays as written). */
function shq(w: string): string { return /^[A-Za-z0-9_@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, "'\\''")}'`; }

/** The command a Code terminal types for this argv: `aos …` without the page's own `--dry-run`, `--expect` and `--json`. */
export function terminalLine(argv: readonly string[]): string {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run" || argv[i] === "--json") continue;
    if (argv[i] === "--expect") { i++; continue; }
    out.push(argv[i]);
  }
  return ["aos", ...out].map(shq).join(" ");
}

/** A1's paste, as a report carries it. */
export interface Paste { line: string; under: string; file: string; note: string }

function pasteOf(j: Record<string, unknown>): Paste | null {
  const line = str(j.paste);
  if (!line) return null;
  return { line, under: str(j.pasteUnder) ?? "", file: str(j.pasteFile) ?? "", note: str(j.pasteNote) ?? "" };
}

/** What `aos mcp park|unpark|remove --json` answers (cli/mcp.js hostWrite). */
export interface HostPlan {
  verb: HostVerb;
  dryRun: boolean;
  name: string;
  host: McpHost;
  transport: string;
  /** The host's command, every secret hidden. */
  command: string;
  file: string;
  backup: string | null;
  /** Where park keeps the entry (park, unpark). */
  stash: string | null;
  paste: Paste | null;
  expect: string;
  listed?: boolean;
  removed?: boolean;
}

/** The answer as a plan for exactly this request (the verb, server and host asked, a dry run when `dryRun`), else null. */
export function hostPlanFor(j: unknown, verb: HostVerb, name: string, h: McpHost, dryRun?: boolean): HostPlan | null {
  if (!isObj(j) || j.ok !== true || j.verb !== verb || j.name !== name || host(j.host) !== h) return null;
  if (typeof j.command !== "string" || typeof j.file !== "string" || typeof j.expect !== "string" || !MCP_HASH_RE.test(j.expect)) return null;
  if (dryRun !== undefined && (j.dryRun === true) !== dryRun) return null;
  return {
    verb, dryRun: j.dryRun === true, name, host: h, transport: String(j.transport ?? "stdio"), command: j.command, file: j.file,
    backup: str(j.backup), stash: str(j.stash), paste: pasteOf(j), expect: j.expect,
    ...(typeof j.listed === "boolean" ? { listed: j.listed } : {}), ...(typeof j.removed === "boolean" ? { removed: j.removed } : {}),
  };
}

/** One host's part of an add (cli/mcp.js add). */
export interface AddHostPlan { host: McpHost; command: string; file: string; backup: string | null; paste: Paste | null; listed?: boolean }
/** What `aos mcp add --json` answers. */
export interface AddPlan { dryRun: boolean; name: string; to: AddTo; transport: string; secrets: string[]; hosts: AddHostPlan[]; expect: string }

/** The answer as a plan for exactly this add (its name, its targets in order, a dry run when `dryRun`), else null. */
export function addPlanFor(j: unknown, name: string, to: AddTo, dryRun?: boolean): AddPlan | null {
  if (!isObj(j) || j.ok !== true || j.verb !== "add" || j.name !== name || j.to !== to || !Array.isArray(j.hosts)) return null;
  if (typeof j.expect !== "string" || !MCP_HASH_RE.test(j.expect)) return null;
  if (dryRun !== undefined && (j.dryRun === true) !== dryRun) return null;
  const want: McpHost[] = to === "both" ? ["claude", "codex"] : [to];
  const hosts: AddHostPlan[] = [];
  for (const x of j.hosts) {
    if (!isObj(x) || typeof x.command !== "string" || typeof x.file !== "string") return null;
    const h = host(x.host);
    if (!h) return null;
    hosts.push({ host: h, command: x.command, file: x.file, backup: str(x.backup), paste: pasteOf(x), ...(typeof x.listed === "boolean" ? { listed: x.listed } : {}) });
  }
  if (hosts.map((x) => x.host).join(",") !== want.join(",")) return null;
  return {
    dryRun: j.dryRun === true, name, to, transport: String(j.transport ?? "stdio"), hosts, expect: j.expect,
    secrets: Array.isArray(j.secrets) ? j.secrets.map(String) : [],
  };
}

export interface Confirm { title: string; message: string; detail: string; confirm: string; danger: boolean }

function pasteLines(p: Paste): string[] {
  return [`Then paste under ${p.under} in ${p.file}:`, `  ${p.line}`];
}

/** The confirm a park, Turn on or remove dry run gives: what happens, then the exact command, file, backup and stash. */
export function hostConfirm(p: HostPlan): Confirm {
  const on = MCP_HOST_LABEL[p.host];
  const lines = [`Writes ${p.file}`, p.backup ? `Backs it up first to ${p.backup}` : "No backup: the file does not exist yet"];
  if (p.verb === "park" && p.stash) lines.push(`Keeps its exact entry in ${p.stash}`);
  if (p.verb === "unpark" && p.stash) lines.push(`From ${p.stash}, deleted once ${on} lists it`);
  lines.push("", p.command);
  if (p.paste) lines.push("", ...pasteLines(p.paste));
  const hidden = "Environment and header values, URL credentials and queries, and arguments named or shaped like secrets are hidden here.";
  if (p.verb === "park") {
    return {
      title: `Park ${p.name}?`, confirm: "Park", danger: false, detail: lines.join("\n"),
      message: `Removes it from ${on} and keeps its exact settings in a private stash outside the vault; Turn on puts it back unchanged.`,
    };
  }
  if (p.verb === "unpark") {
    return {
      title: `Turn ${p.name} back on?`, confirm: "Turn on", danger: false, detail: lines.join("\n"),
      message: `Puts it back on ${on} as it was, through ${on}'s own CLI.${p.paste ? ` ${p.paste.note}: \`codex mcp add\` takes values only, so paste the line below to pass them.` : ""} ${hidden}`,
    };
  }
  return {
    title: `Remove ${p.name} from ${on}?`, confirm: "Remove", danger: true, detail: lines.join("\n"),
    message: `Takes it out of ${on}'s config for good, through ${on}'s own CLI. The backup keeps the file as it was; nothing is stashed, so Turn on cannot bring it back.`,
  };
}

/** The confirm an add's dry run gives: each host's exact command, file and backup, and A1's paste line for Codex. */
export function addConfirm(p: AddPlan): Confirm {
  const on = p.hosts.map((h) => MCP_HOST_LABEL[h.host]).join(" and ");
  const lines: string[] = [];
  for (const h of p.hosts) {
    if (lines.length) lines.push("");
    lines.push(`${MCP_HOST_LABEL[h.host]}: writes ${h.file}`, h.backup ? `  backs it up first to ${h.backup}` : "  no backup: the file does not exist yet", h.command);
    if (h.paste) lines.push(...pasteLines(h.paste));
  }
  const paste = p.hosts.find((h) => h.paste)?.paste ?? null;
  const notes = [`A dry run found nothing in the way. This adds ${p.name} to ${on} through each host's own CLI.`];
  if (p.secrets.length) notes.push(`Secrets go by name only (${p.secrets.join(", ")}): each is read from your environment when the server starts.`);
  if (paste) notes.push(`${paste.note}: \`codex mcp add\` takes values only, so paste the env_vars line below to pass them.`);
  return { title: `Add ${p.name} to ${on}?`, message: notes.join(" "), detail: lines.join("\n"), confirm: p.hosts.length > 1 ? "Add to both" : `Add to ${on}`, danger: false };
}

// ── the Add sheet's form ─────────────────────────────────────────────────────

export interface AddForm {
  name: string;
  kind: "local" | "remote";
  /** The command line: the program and its arguments, as a shell splits them (quotes kept together). */
  command: string;
  url: string;
  /** Rows of `NAME ← $VAR`; for a remote server the first row's variable is the bearer token's. */
  secrets: { key: string; var: string }[];
  hosts: McpHost[];
}

/** A command line's words as a shell splits them: blanks split; '…' and "…" keep their text. → null when a quote is open. */
export function splitCommand(text: string): string[] | null {
  const out: string[] = [];
  let cur = "";
  let open = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (/\s/.test(c)) { if (open) { out.push(cur); cur = ""; open = false; } continue; }
    open = true;
    if (c === "'" || c === "\"") {
      const end = text.indexOf(c, i + 1);
      if (end === -1) return null;
      cur += text.slice(i + 1, end);
      i = end;
    } else cur += c;
  }
  if (open) out.push(cur);
  return out;
}

/** A variable as typed, `$VAR` or `VAR`: its name. */
function varName(v: string): string { return v.trim().replace(/^\$/, ""); }

/**
 * The Add sheet's form as a spec, or what is wrong with it (the first problem, in words). `taken` holds the names each
 * host has already (as the board shows them), so a clash is said before the dry run would refuse it.
 */
export function checkAdd(f: AddForm, enabled: readonly McpHost[], taken: Partial<Record<McpHost, ReadonlySet<string>>> = {}): { spec: AddSpec } | { error: string } {
  const name = f.name.trim();
  if (!name) return { error: "Name the server." };
  if (!MCP_NAME_RE.test(name)) return { error: "A name takes letters, digits, - and _ only (at most 64), as both CLIs do." };
  if (name === OWN) return { error: "agenticos is the vault's own server." };
  const hosts = (["claude", "codex"] as const).filter((h) => f.hosts.includes(h) && enabled.includes(h));
  if (!hosts.length) return { error: "Choose a host to add it to." };
  for (const h of hosts) if (taken[h]?.has(name)) return { error: `${MCP_HOST_LABEL[h]} already has a server named ${name}.` };
  const rows = f.secrets.filter((r) => r.key.trim() || r.var.trim());
  const env: { key: string; var: string }[] = [];
  for (const r of rows) {
    const key = r.key.trim();
    const v = varName(r.var);
    if (f.kind === "local" && !ENV_KEY_RE.test(key)) return { error: `${key || "A secret"} is not a variable name the server can read (letters, digits and _).` };
    if (!VAR_NAME_RE.test(v) || TOKEN_SHAPE.test(v) || v.length > 64) return { error: `Give ${key || "the secret"} the name of a variable, such as $GITHUB_TOKEN: upper case, digits and _, never the value itself.` };
    if (f.kind === "local" && env.some((e) => e.key === key)) return { error: `${key} is given twice.` };
    env.push({ key, var: v });
  }
  const to: AddTo = hosts.length === 2 ? "both" : hosts[0];
  if (f.kind === "remote") {
    const url = f.url.trim();
    if (!/^https?:\/\/\S+$/.test(url)) return { error: "Give the server's http or https URL." };
    try { const u = new URL(url); if (u.username || u.password) return { error: "Leave credentials out of the URL: give the token's variable instead." }; } catch { return { error: "Give the server's http or https URL." }; }
    if (env.length > 1) return { error: "A remote server takes one secret, its bearer token's variable." };
    return { spec: { name, to, kind: "remote", command: "", args: [], url, bearer: env[0]?.var ?? null, env: [] } };
  }
  const words = splitCommand(f.command);
  if (words === null) return { error: "A quote in the command does not close." };
  if (!words.length) return { error: "Give the command that starts the server." };
  const [command, ...args] = words;
  if (command.startsWith("-")) return { error: "The command starts with the program to run, not a flag." };
  if (args.length > MAX_ARGS) return { error: `At most ${MAX_ARGS} arguments.` };
  if (env.length > MAX_ENV) return { error: `At most ${MAX_ENV} secrets and settings.` };
  if (words.some((w) => !w || w.length > 1024 || /[\0\n\r\u2028\u2029]/.test(w))) return { error: "An argument is empty, too long, or holds a line break." };
  return { spec: { name, to, kind: "local", command, args, url: "", bearer: null, env } };
}
