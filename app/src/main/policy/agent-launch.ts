// The arguments a Code launch may pass the agent CLI that main starts as a terminal's own process (agent-computer D18).
// Only what the Code page's launchArgs emits (hud/src/data/terminalLaunch.ts): the model, the access level's flags, a
// conversation id, and for a Codex resume by id the folder (`-C`) and, after the id, a chip restart's picks (`-m`, `-s`,
// `-a`, each at most once: the words a new Codex session may carry, so they widen nothing; code-chat R66). Anything else
// (a skip-permission or MCP flag, a prompt, a `-c` override, a value that reads as a flag) is refused: the page chooses
// the words, never the program, and cannot widen what the agent may do through them. Claude's `--allowedTools` takes one comma-joined value of Bash and the
// computer tools (agent-computer D33: they are pre-approved, the app's ask gate is their gate) and nothing else. Every
// `-c` key stays refused: Codex's per-tool approvals ship in its MCP registration, never on the launch line. Codex's
// `--no-daemon` (R70: the TUI runs its app server in its own process, so the MCP server stays the CLI's child) comes
// among a new session's flags and right after `resume` on a resume's; it widens nothing, and it is accepted only when
// main's spawn check says this launch carries it (R79: `allow.noDaemon`).

import type { ComputerTool } from "../computer/bridge";

type Host = "claude" | "codex";

/** A C0 control character or DEL, which no value on the line may hold. */
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** A free value (a model, an id): present, not a flag, no control character. */
function free(v: string | undefined): boolean {
  return typeof v === "string" && v.length > 0 && !v.startsWith("-") && !CONTROL_RE.test(v);
}

const oneOf = (...allowed: string[]) => (v: string | undefined): boolean => typeof v === "string" && allowed.includes(v);

/** The computer tools as Claude Code names the agenticos plugin's (hud/src/data/terminalLaunch.ts COMPUTER_TOOLS). */
const COMPUTER_TOOLS = ["computer_open", "computer_snapshot", "computer_screenshot", "computer_click", "computer_type", "computer_key",
  "computer_scroll", "computer_wait", "computer_status"] as const satisfies readonly ComputerTool[];
const ALLOWED_TOOLS: ReadonlySet<string> = new Set(["Bash", ...COMPUTER_TOOLS.map((t) => `mcp__plugin_agenticos_agenticos__${t}`)]);

/** `--allowedTools`' one value: Bash and computer tools, comma-joined, each at most once, no empty entry. */
function allowedTools(v: string | undefined): boolean {
  if (typeof v !== "string" || !v) return false;
  const names = v.split(",");
  return names.every((n) => ALLOWED_TOOLS.has(n)) && new Set(names).size === names.length;
}

/** A flag's value rule, or null for a flag that takes none. */
type Rule = ((v: string | undefined) => boolean) | null;

const CLAUDE_FLAGS: Readonly<Record<string, Rule>> = {
  "--model": free,
  "--permission-mode": oneOf("plan", "acceptEdits"),
  "--allowedTools": allowedTools,
  "--continue": null,
  "--resume": free,
  "--session-id": free,
};

const CODEX_FLAGS: Readonly<Record<string, Rule>> = {
  "--no-daemon": null,
  "-m": free,
  "-s": oneOf("read-only", "workspace-write"),
  "-a": oneOf("on-request"),
};

/** What may follow a Codex resume's id (a chip's pick, R66): a new session's flags with their rules, but `--no-daemon`. */
const CODEX_RESUME_PICKS: Readonly<Record<string, Rule>> = { "-m": CODEX_FLAGS["-m"], "-s": CODEX_FLAGS["-s"], "-a": CODEX_FLAGS["-a"] };

/** Why `argv` (flags and values only, no positional word) is refused, or null. Each flag at most once. */
function flagsRefusal(argv: readonly string[], rules: Readonly<Record<string, Rule>>): string | null {
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-c" || a === "--config") return "a -c override";
    if (!Object.prototype.hasOwnProperty.call(rules, a)) {
      return a.startsWith("-") ? `the flag ${a.slice(0, 40)}` : "a word that is not a flag";
    }
    if (seen.has(a)) return `${a} twice`;
    seen.add(a);
    const rule = rules[a];
    if (rule === null) continue;
    const v = argv[i + 1];
    if (!rule(v)) return `${a} with ${v === undefined ? "no value" : `the value ${JSON.stringify(v.slice(0, 40))}`}`;
    i++;
  }
  return null;
}

/** Why a Code launch's argv is refused, or null when it is one launchArgs builds. One line. `allow.noDaemon`: main's
 *  answer for this launch (R79); without it a Codex `--no-daemon` is refused. */
export function agentArgvRefusal(host: Host, argv: readonly string[], allow: { noDaemon: boolean } = { noDaemon: false }): string | null {
  if (host === "claude") return flagsRefusal(argv, CLAUDE_FLAGS);
  if (!allow.noDaemon && argv.includes("--no-daemon")) return "--no-daemon, which main did not choose for this launch";
  if (argv[0] !== "resume") return flagsRefusal(argv, CODEX_FLAGS);
  // `codex resume [--no-daemon] --last`, or `codex resume [--no-daemon] [-C <absolute folder>] <id> [-m <model>] [-s …]
  // [-a …]` (a chip restart's picks, R66: `codex resume --help` takes options after the id).
  const rest = argv[1] === "--no-daemon" ? argv.slice(2) : argv.slice(1);
  if (rest.includes("--no-daemon")) return "--no-daemon where a resume does not take it";
  if (rest.length === 1 && rest[0] === "--last") return null;
  let at = 0;
  if (rest[0] === "-C") {
    const dir = rest[1];
    if (dir === undefined || !dir.startsWith("/") || CONTROL_RE.test(dir)) return "-C with a folder that is not an absolute path";
    at = 2;
  }
  const id = rest[at];
  if (id === "-c" || id === "--config") return "a -c override";
  if (!free(id)) return at ? `the resume id ${JSON.stringify((id ?? "").slice(0, 40))}` : "a resume this app does not launch";
  return flagsRefusal(rest.slice(at + 1), CODEX_RESUME_PICKS);
}
