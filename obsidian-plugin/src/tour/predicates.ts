// What a step's `when` may name, and the words its text fills in (tour C5, C8). A step whose `when` fails is skipped,
// so a Codex-only, a no-host or a Sessions-hidden install sees only what it has. The context is built by the plugin from
// sessionHosts() (agenticos.json's hosts) and chatAvailable() (provider-state.json); this module only reads it. Pure,
// so node:test can load it.

export type TourHost = "claude" | "codex";

export interface TourContext {
  /** The session hosts this Mac runs (sessionHosts()). */
  hosts: TourHost[];
  /** A provider is on record, so Sessions is on the rail (chatAvailable()). */
  chat: boolean;
  /** The Getting started item is on the rail (not put away, not finished). */
  checklist: boolean;
  /** How the user types an in-session command on their hosts (aosConfig invocationHint): "/todo", "$agenticos:todo"… */
  cmd?: (name: string) => string;
}

/** Every predicate a step may name in `when`; `!` before one negates it. */
export const PREDICATES = ["hasHost:claude", "hasHost:codex", "chatAvailable", "codexOnly", "noHost", "checklistShown"] as const;
export type Predicate = typeof PREDICATES[number];

const HOST_NAME: Record<TourHost, string> = { claude: "Claude Code", codex: "Codex" };

/** Whether `when` names a known predicate (with or without `!`). */
export function isPredicate(when: string): boolean {
  return (PREDICATES as readonly string[]).includes(when.startsWith("!") ? when.slice(1) : when);
}

function test(p: Predicate, ctx: TourContext): boolean {
  switch (p) {
    case "hasHost:claude": return ctx.hosts.includes("claude");
    case "hasHost:codex": return ctx.hosts.includes("codex");
    case "chatAvailable": return ctx.chat;
    case "codexOnly": return ctx.hosts.length === 1 && ctx.hosts[0] === "codex";
    case "noHost": return ctx.hosts.length === 0;
    case "checklistShown": return ctx.checklist;
  }
}

/** Whether a step (or chapter) with this `when` shows. No `when` always shows; an unknown predicate never does. */
export function holds(when: string | undefined | null, ctx: TourContext): boolean {
  if (!when) return true;
  const neg = when.startsWith("!");
  const name = neg ? when.slice(1) : when;
  if (!isPredicate(name)) return false;
  return test(name as Predicate, ctx) !== neg;
}

/** The user's host as step text names it: one host by name, both joined by "or", none as "your agent". */
export function hostName(ctx: TourContext): string {
  const names = ctx.hosts.map((h) => HOST_NAME[h]);
  if (!names.length) return "your agent";
  return names.join(" or ");
}

/** Step text with `{host}` and `{cmd:<name>}` filled in for this Mac. Anything else in braces is left as written. */
export function fillText(text: string, ctx: TourContext): string {
  return text
    .replace(/\{host\}/g, hostName(ctx))
    .replace(/\{cmd:([a-z0-9-]+)\}/g, (_m, name: string) => (ctx.cmd ? ctx.cmd(name) : `/${name}`));
}

/** Plain text with `**bold**` runs, split for rendering (no HTML is ever built from step text). */
export function boldRuns(text: string): Array<{ text: string; bold: boolean }> {
  const out: Array<{ text: string; bold: boolean }> = [];
  const re = /\*\*([^*]+)\*\*/g;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > at) out.push({ text: text.slice(at, m.index), bold: false });
    out.push({ text: m[1], bold: true });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), bold: false });
  return out;
}
