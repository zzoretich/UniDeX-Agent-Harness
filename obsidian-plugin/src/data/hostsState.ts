// hostsState.ts — Settings ▸ Hosts (install-import B2): each session host's state, on in agenticos.json, its CLI installed,
// signed in, and the one thing to do next. The runtime answers through `aos hosts status --json` (cli/hosts.js: the
// lookup and the login checks `aos hosts add` itself makes, no model call); until it has, the caches stand in
// (agenticos.json, and provider-state.json's login cache). Pure (types only), so node:test drives it.
import type { AgenticosJson, ProviderState, SessionHost } from "./aosConfig";

export const HOSTS: readonly SessionHost[] = ["claude", "codex"];
export const HOST_LABEL: Record<SessionHost, string> = { claude: "Claude Code", codex: "Codex" };

/**
 * How each CLI installs from a terminal: its maker's own installer, as the setup wizard's Finish shows it. Once a vault
 * is attached the wizard's checked downloads (app/src/main/setup/toolchain.ts) are not reachable from the Workbench, so
 * Settings ▸ Hosts shows these steps instead.
 */
export const INSTALL_COMMAND: Record<SessionHost, string> = {
  claude: "curl -fsSL https://claude.ai/install.sh | bash",
  codex: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
};
export const LOGIN_COMMAND: Record<SessionHost, string> = { claude: "claude auth login", codex: "codex login" };

export interface HostStatus {
  enabled: boolean;
  /** null: not known yet (the caches had no answer). */
  installed: boolean | null;
  bin: string | null;
  signedIn: boolean | null;
  /** Its sign-in check did not answer in time (`aos hosts status` stops it after 10 s). */
  timedOut?: boolean;
}
export interface HostsStatus {
  /** Where it came from: the runtime's own check, or the caches until it answers. */
  source: "runtime" | "cache";
  hosts: Record<SessionHost, HostStatus>;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** `aos hosts status --json` → the state; null when it is not that. */
export function parseHostsStatus(j: unknown): HostsStatus | null {
  if (!isObj(j) || !isObj(j.hosts)) return null;
  const hosts = {} as Record<SessionHost, HostStatus>;
  for (const h of HOSTS) {
    const x = j.hosts[h];
    if (!isObj(x)) return null;
    hosts[h] = {
      enabled: x.enabled === true, installed: x.installed === true, bin: typeof x.bin === "string" ? x.bin : null,
      signedIn: typeof x.signedIn === "boolean" ? x.signedIn : null,
      ...(x.probe === "timed out" ? { timedOut: true } : {}),
    };
  }
  return { source: "runtime", hosts };
}

/** What the caches say before the runtime answers: on from agenticos.json, signed in and the CLI from the login cache. */
export function cachedHostsStatus(cfg: AgenticosJson | null, state: ProviderState | null): HostsStatus {
  const hosts = {} as Record<SessionHost, HostStatus>;
  for (const h of HOSTS) {
    const enabled = !!cfg && (cfg.hosts ? cfg.hosts[h]?.enabled === true : h === "claude");
    const login = state?.[h];
    const bin = (login?.bin || cfg?.hosts?.[h]?.bin || (h === "claude" ? cfg?.claude?.bin : cfg?.codex?.bin)) ?? null;
    hosts[h] = { enabled, installed: login ? !!login.bin || login.loggedIn === true : bin ? true : null, bin: bin || null, signedIn: login ? login.loggedIn === true : null };
  }
  return { source: "cache", hosts };
}

export type HostState = "ready" | "signed-out" | "missing" | "off" | "off-signed-out" | "off-missing" | "unknown";

export interface HostView {
  host: SessionHost;
  label: string;
  state: HostState;
  /** One line: what it is now. */
  text: string;
  /** Add <host>: on only when its CLI is installed and signed in (what `aos hosts add` checks first). */
  add: { shown: boolean; enabled: boolean; why: string | null };
  /** The sign-in to run in a Code terminal, when it is installed and signed out. */
  signIn: string | null;
  /** How to install it from a terminal, step by step, when its CLI is missing. */
  install: string[] | null;
}

/** The row Settings ▸ Hosts draws for a host. */
export function hostView(host: SessionHost, s: HostStatus): HostView {
  const label = HOST_LABEL[host];
  const where = s.bin ? ` · ${s.bin}` : "";
  const unknown = s.timedOut ? "its sign-in check did not answer in time; ⟳ Check again" : "not checked yet";
  const installSteps = [
    "Open Terminal (in Applications ▸ Utilities).",
    `Type ${INSTALL_COMMAND[host]} and press Return.`,
    `Type ${LOGIN_COMMAND[host]} and press Return to sign in.`,
    `Then ⟳ Check again here${s.enabled ? "" : `, and Add ${label}`}.`,
  ];
  const base = { host, label, signIn: null as string | null, install: null as string[] | null };
  if (s.enabled) {
    if (s.installed === false) return { ...base, state: "missing", text: `On, but its CLI is not found: sessions and duties on ${label} wait until it is installed.`, add: { shown: false, enabled: false, why: null }, install: installSteps };
    if (s.signedIn === false) return { ...base, state: "signed-out", text: `On, but signed out${where}: sessions and duties on ${label} wait until you sign in.`, add: { shown: false, enabled: false, why: null }, signIn: LOGIN_COMMAND[host] };
    if (s.signedIn === true) return { ...base, state: "ready", text: `On · signed in${where}`, add: { shown: false, enabled: false, why: null } };
    return { ...base, state: "unknown", text: `On${where} · ${unknown}`, add: { shown: false, enabled: false, why: null } };
  }
  if (s.installed === false) {
    return { ...base, state: "off-missing", text: `Not installed on this Mac.`, add: { shown: true, enabled: false, why: `Install ${label} and sign in first` }, install: installSteps };
  }
  if (s.signedIn === false) {
    return { ...base, state: "off-signed-out", text: `Installed${where}, signed out.`, add: { shown: true, enabled: false, why: `Sign in to ${label} first (${LOGIN_COMMAND[host]})` }, signIn: LOGIN_COMMAND[host] };
  }
  if (s.signedIn === true) {
    return { ...base, state: "off", text: `Installed and signed in${where}; not added to this vault yet.`, add: { shown: true, enabled: true, why: null } };
  }
  return { ...base, state: "unknown", text: `Not added to this vault${where} · ${unknown}`, add: { shown: true, enabled: false, why: s.timedOut ? "Its sign-in check did not answer: ⟳ Check again" : "Checking whether it is installed and signed in…" } };
}

/** What Add does, said before it runs (the confirm). */
export function addHostText(host: SessionHost): string {
  const label = HOST_LABEL[host];
  return `This turns ${label} on for this vault (the other host stays as it is), installs ${host === "claude" ? "the Claude Code plugin" : "the Codex plugin (or the direct wiring on an older Codex CLI)"}, `
    + `imports ${label}'s instructions, memories and MCP server list into Brain ▸ Review, proposes its project folders, and re-renders the installed schedules. `
    + `It runs aos hosts add ${host}. Its session history waits for Import under Import.`;
}

/** The steps `aos hosts add` prints after "Next steps:", one per line, without their numbers. */
export function nextSteps(stdout: string): string[] {
  const i = stdout.indexOf("Next steps:");
  if (i < 0) return [];
  const out: string[] = [];
  for (const line of stdout.slice(i + "Next steps:".length).split("\n")) {
    const m = /^\s+\d+\.\s+(.*)$/.exec(line);
    if (m) out.push(m[1].trim());
    else if (line.trim() && out.length) out[out.length - 1] += ` ${line.trim()}`;
  }
  return out;
}
