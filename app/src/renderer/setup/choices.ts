// The wizard's small rules, with no imports so the unit suite can hold them: which host is offered and chosen (inspection
// round 2, M2), and how a command the user is told to type quotes the vault (M4).

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

/** A word for a POSIX shell: as it is when it holds only safe characters, else single-quoted (a ' becomes '\''). */
export function shellQuote(word: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;
}

/** The vault as an absolute path (a typed ~/… resolved against home), so the command works from any folder and quotes cleanly. */
export function absoluteVault(vault: string, home: string): string {
  const v = vault.trim();
  return v === "~" ? home : v.startsWith("~/") ? `${home.replace(/\/+$/, "")}/${v.slice(2)}` : v;
}

/** The command Finish shows for adding a host to a vault installed with none (M4: the vault quoted for the shell). */
export function addHostCommand(aos: string, vault: string, home: string): string {
  return `${aos} init --vault ${shellQuote(absoluteVault(vault, home))} --host claude`;
}
