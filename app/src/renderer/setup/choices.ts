// The wizard's small rules, with no imports so the unit suite can hold them: which host is offered and chosen (inspection
// round 2, M2; round 3, F5), and the command Finish tells a user with no host to type.

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
