// The wizard's small rules, with no imports so the unit suite can hold them: which host is offered and chosen (inspection
// round 2, M2; round 3, F5), the command Finish tells a user with no host to type, and an earlier install's hosts that a
// choice would drop (F7).

export type HostChoice = "claude" | "codex" | "both" | "none";
export interface ReadyHosts { claude: boolean; codex: boolean }

/** The host to offer first: both when both are ready, else the one that is, else none yet (install-import B2). */
export function defaultHost(ready: ReadyHosts): HostChoice {
  return ready.claude && ready.codex ? "both" : ready.codex ? "codex" : ready.claude ? "claude" : "none";
}

/**
 * Whether Choose offers `host`: a host when it is ready, both when both are, and "No agent CLI yet" always (inspection
 * round 3, F5: a user with a host may still install without one).
 */
export function hostOffered(host: HostChoice, ready: ReadyHosts): boolean {
  return host === "none" ? true : host === "both" ? ready.claude && ready.codex : ready[host];
}

/**
 * The host after a check (M2, F5). A choice the user made (`picked`) stands while Choose still offers it, "No agent CLI
 * yet" included; a choice the wizard made for them follows what is ready now, so a host logged in since becomes the
 * choice. A choice no longer offered falls back to the default. Install never sends a choice whose radio is not checked.
 */
export function reconcileHost(current: HostChoice | null, ready: ReadyHosts, picked = false): HostChoice {
  return current && picked && hostOffered(current, ready) ? current : defaultHost(ready);
}

/**
 * The command Finish shows for adding a host to an install made with none: `aos hosts add` (install-import B2), which
 * wires it into the vault agenticos.json names. It carries no path, so nothing in it needs quoting (inspection M4).
 */
export function addHostCommand(aos: string, host: "claude" | "codex" = "claude"): string {
  return `${aos} hosts add ${host}`;
}

/**
 * Inspection F7, made a choice: the hosts an earlier install's agenticos.json has on that `choice` would drop. `aos init`
 * refuses such an install (it never unwires a host, so the host's plugin, hooks and MCP server would stay while
 * agenticos.json said it was off); Choose names each one and offers to keep it or to take its wiring out first.
 */
export function droppedHosts(choice: HostChoice, wired: ReadyHosts | null | undefined): Array<"claude" | "codex"> {
  if (!wired) return [];
  const want = { claude: choice === "claude" || choice === "both", codex: choice === "codex" || choice === "both" };
  return (["claude", "codex"] as const).filter((h) => wired[h] && !want[h]);
}

/** The choice that keeps every wired host on as well (F7's "keep it"), when Choose offers it; null when it does not. */
export function keepingChoice(choice: HostChoice, wired: ReadyHosts | null | undefined, ready: ReadyHosts): HostChoice | null {
  if (!wired) return null;
  const claude = wired.claude || choice === "claude" || choice === "both";
  const codex = wired.codex || choice === "codex" || choice === "both";
  const keep: HostChoice = claude && codex ? "both" : claude ? "claude" : codex ? "codex" : "none";
  return hostOffered(keep, ready) ? keep : null;
}
