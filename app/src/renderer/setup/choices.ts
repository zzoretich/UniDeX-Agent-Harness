// The wizard's small rules, with no imports so the unit suite can hold them: which host is offered and chosen (inspection
// round 2, M2), and how a command the user is told to type quotes the vault (M4).

export type HostChoice = "claude" | "codex" | "both" | "none";
export interface ReadyHosts { claude: boolean; codex: boolean }

/** The host to offer first: both when both are ready, else the one that is, else none yet (install-import B2). */
export function defaultHost(ready: ReadyHosts): HostChoice {
  return ready.claude && ready.codex ? "both" : ready.codex ? "codex" : ready.claude ? "claude" : "none";
}

/** Whether Choose shows `host` as a choice: a host when it is ready, both when both are, none only when neither is. */
export function hostOffered(host: HostChoice, ready: ReadyHosts): boolean {
  return host === "none" ? !ready.claude && !ready.codex : host === "both" ? ready.claude && ready.codex : ready[host];
}

/**
 * The host after a check (M2): the user's choice while Choose still offers it, else the default. A check that finds a
 * host newly logged in never leaves "none" chosen with no radio for it, so Install never sends --host none unseen.
 */
export function reconcileHost(current: HostChoice | null, ready: ReadyHosts): HostChoice {
  return current && hostOffered(current, ready) ? current : defaultHost(ready);
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
