// The arguments a Code launch may pass the agent CLI that main starts as a terminal's own process (agent-computer D18).
// Only what the Code page's launchArgs emits (hud/src/data/terminalLaunch.ts): the model, the access level's flags, a
// conversation id, and for a Codex resume by id the folder (`-C`). Anything else (a skip-permission or MCP flag, a
// prompt, a `-c` override, a value that reads as a flag) is refused: the page chooses the words, never the program, and
// cannot widen what the agent may do through them. Every `-c` key is refused for now; the approval keys come later.

type Host = "claude" | "codex";

/** A C0 control character or DEL, which no value on the line may hold. */
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** A free value (a model, an id): present, not a flag, no control character. */
function free(v: string | undefined): boolean {
  return typeof v === "string" && v.length > 0 && !v.startsWith("-") && !CONTROL_RE.test(v);
}

const oneOf = (...allowed: string[]) => (v: string | undefined): boolean => typeof v === "string" && allowed.includes(v);

/** A flag's value rule, or null for a flag that takes none. */
type Rule = ((v: string | undefined) => boolean) | null;

const CLAUDE_FLAGS: Readonly<Record<string, Rule>> = {
  "--model": free,
  "--permission-mode": oneOf("plan", "acceptEdits"),
  "--allowedTools": oneOf("Bash"),
  "--continue": null,
  "--resume": free,
  "--session-id": free,
};

const CODEX_FLAGS: Readonly<Record<string, Rule>> = {
  "-m": free,
  "-s": oneOf("read-only", "workspace-write"),
  "-a": oneOf("on-request"),
};

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

/** Why a Code launch's argv is refused, or null when it is one launchArgs builds. One line. */
export function agentArgvRefusal(host: Host, argv: readonly string[]): string | null {
  if (host === "claude") return flagsRefusal(argv, CLAUDE_FLAGS);
  if (argv[0] !== "resume") return flagsRefusal(argv, CODEX_FLAGS);
  // `codex resume --last`, or `codex resume [-C <absolute folder>] <id>`.
  const rest = argv.slice(1);
  if (rest.length === 1 && rest[0] === "--last") return null;
  if (rest.length === 1 && free(rest[0])) return null;
  if (rest.length === 3 && rest[0] === "-C") {
    const dir = rest[1];
    if (!dir.startsWith("/") || CONTROL_RE.test(dir)) return "-C with a folder that is not an absolute path";
    return free(rest[2]) ? null : `the resume id ${JSON.stringify(rest[2].slice(0, 40))}`;
  }
  if (rest.includes("-c") || rest.includes("--config")) return "a -c override";
  return "a resume this app does not launch";
}
